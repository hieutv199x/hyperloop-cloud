import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { WorkflowRecord } from '../../domain/types.js';
import {
  ConditionalWriteError,
  type WorkflowRepository,
} from './workflow-repository.js';

/**
 * DynamoDB single-table adapter.
 * Keys:
 * - workflow meta: pk=WF#..., sk=META
 * - event dedupe: pk=EVENT#<eventId>, sk=META (optional TTL later)
 */
export class DynamoDbWorkflowRepository implements WorkflowRepository {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async getById(workflowId: string): Promise<WorkflowRecord | null> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: workflowId, sk: 'META' },
      }),
    );
    return (result.Item?.record as WorkflowRecord | undefined) ?? null;
  }

  async createIfAbsent(workflow: WorkflowRecord): Promise<'created' | 'exists'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: workflow.workflowId,
            sk: 'META',
            entityType: 'WORKFLOW',
            status: workflow.status,
            updatedAt: workflow.updatedAt,
            record: workflow,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'created';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'exists';
      }
      throw error;
    }
  }

  async updateConditional(
    workflow: WorkflowRecord,
    expectedVersion: number,
  ): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: workflow.workflowId, sk: 'META' },
          UpdateExpression:
            'SET #record = :record, #status = :status, updatedAt = :updatedAt',
          ConditionExpression: '#record.#version = :expectedVersion',
          ExpressionAttributeNames: {
            '#record': 'record',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':record': workflow,
            ':status': workflow.status,
            ':updatedAt': workflow.updatedAt,
            ':expectedVersion': expectedVersion,
          },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConditionalWriteError(
          `Version conflict for ${workflow.workflowId}`,
        );
      }
      throw error;
    }
  }

  async recordEventOnce(
    eventId: string,
    workflowId: string,
  ): Promise<'recorded' | 'duplicate'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `EVENT#${eventId}`,
            sk: 'META',
            entityType: 'EVENT',
            workflowId,
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'recorded';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'duplicate';
      }
      throw error;
    }
  }

  async listTimeline(workflowId: string): Promise<WorkflowRecord['timeline']> {
    const workflow = await this.getById(workflowId);
    return workflow?.timeline ?? [];
  }
}
