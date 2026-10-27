import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentStage, SchedulerConfig } from '../../scheduler/config.js';
import type { PriorityPolicy } from '../../scheduler/priority-policy.js';
import { ReservationConflictError } from '../../scheduler/atomic-store.js';
import type { SchedulerStorePort } from '../../scheduler/ports.js';
import type {
  CapacitySnapshot,
  EnqueueTaskInput,
  ReadyTask,
  Reservation,
} from '../../scheduler/types.js';

const CAPACITY_PK = 'CAPACITY#GLOBAL';
const CAPACITY_SK = 'META';
const QUEUED_GSI_PK = 'QUEUED';

function taskPk(taskId: string): string {
  return `TASK#${taskId}`;
}

function reservationPk(taskId: string, attempt: number): string {
  return `RES#${taskId}#${attempt}`;
}

function approvedPk(workflowId: string): string {
  return `APPROVED#${workflowId}`;
}

function completedPk(taskId: string): string {
  return `COMPLETED#${taskId}`;
}

function queuedSortKey(task: Pick<ReadyTask, 'priority' | 'readyAt' | 'taskId'>): string {
  const pri = String(1_000_000 - task.priority).padStart(7, '0');
  return `${pri}#${task.readyAt}#${task.taskId}`;
}

function deterministicJobName(task: ReadyTask): string {
  const raw = `hl-${task.stage}-${task.taskId}-${task.attempt}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  return raw.slice(0, 63);
}

/**
 * DynamoDB-backed scheduler store: QUEUED intents on GSI + TransactWrite reserve/release.
 */
export class DynamoDbSchedulerStore implements SchedulerStorePort {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly config: SchedulerConfig,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async ensureCapacityInitialized(): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: CAPACITY_PK,
            sk: CAPACITY_SK,
            entityType: 'CAPACITY',
            used: 0,
            limit: this.config.globalMaxConcurrentJobs,
            version: 1,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
    }
  }

  async enqueue(input: EnqueueTaskInput, policy: PriorityPolicy): Promise<ReadyTask> {
    await this.ensureCapacityInitialized();
    const existing = await this.getTask(input.taskId);
    if (existing) return existing;

    if (input.stage === 'coding') {
      const approved = await this.getApprovedSpecHash(input.workflowId);
      if (!input.approvedSpecHash || !approved || approved !== input.approvedSpecHash) {
        throw new Error(
          'Coding task requires exact approved spec hash (HITL) before queueing',
        );
      }
    }

    if (input.dependsOn?.length) {
      for (const dep of input.dependsOn) {
        const done = await this.doc.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: completedPk(dep), sk: 'META' },
          }),
        );
        if (!done.Item) {
          throw new Error(`Dependency not satisfied: ${dep}`);
        }
      }
    }

    const task: ReadyTask = {
      taskId: input.taskId,
      workflowId: input.workflowId,
      stage: input.stage,
      repository: input.repository,
      project: input.project,
      priority: policy.basePriority(input.stage),
      readyAt: new Date().toISOString(),
      attempt: input.attempt ?? 1,
      status: 'QUEUED',
      version: 1,
      approvedSpecHash: input.approvedSpecHash,
      dependsOn: input.dependsOn,
    };
    const blocked = input.dispatchable === false;
    const item: Record<string, unknown> = {
      pk: taskPk(task.taskId),
      sk: 'META',
      entityType: 'TASK',
      task,
      blocked,
      status: task.status,
    };
    if (!blocked) {
      item.gsi1pk = QUEUED_GSI_PK;
      item.gsi1sk = queuedSortKey(task);
    }

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const again = await this.getTask(input.taskId);
        if (again) return again;
      }
      throw error;
    }
    return structuredClone(task);
  }

  async listQueued(): Promise<ReadyTask[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'gsi1-queued-intents',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': QUEUED_GSI_PK },
      }),
    );
    return (result.Items ?? [])
      .map((item) => item.task as ReadyTask)
      .filter((t) => t?.status === 'QUEUED')
      .map((t) => structuredClone(t));
  }

  async getTask(taskId: string): Promise<ReadyTask | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: taskPk(taskId), sk: 'META' },
      }),
    );
    return result.Item?.task
      ? structuredClone(result.Item.task as ReadyTask)
      : undefined;
  }

  async cancelQueued(taskId: string): Promise<void> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: taskPk(taskId), sk: 'META' },
          UpdateExpression:
            'SET #task.#status = :cancelled, #task.#version = #task.#version + :one, #status = :cancelled REMOVE gsi1pk, gsi1sk',
          ConditionExpression: '#task.#status = :queued',
          ExpressionAttributeNames: {
            '#task': 'task',
            '#status': 'status',
            '#version': 'version',
          },
          ExpressionAttributeValues: {
            ':cancelled': 'CANCELLED',
            ':queued': 'QUEUED',
            ':one': 1,
          },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ReservationConflictError(`Cannot cancelQueued: ${taskId}`);
      }
      throw error;
    }
  }

  async markScheduled(taskId: string): Promise<void> {
    await this.setTaskStatus(taskId, 'RESERVED', 'SCHEDULED');
  }

  async markRunning(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    if (task.status === 'SCHEDULED' || task.status === 'RESERVED') {
      await this.setTaskStatus(taskId, task.status, 'RUNNING');
    }
  }

  async markSpecApproved(workflowId: string, specHash: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: approvedPk(workflowId),
          sk: 'META',
          entityType: 'APPROVED_SPEC',
          specHash,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async clearSpecApproval(workflowId: string): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: approvedPk(workflowId),
          sk: 'META',
          entityType: 'APPROVED_SPEC',
          specHash: null,
          cleared: true,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async reserve(taskId: string): Promise<Reservation> {
    await this.ensureCapacityInitialized();
    const task = await this.getTask(taskId);
    if (!task) {
      throw new ReservationConflictError(`Task not found: ${taskId}`);
    }
    if (task.status !== 'QUEUED') {
      throw new ReservationConflictError(`Task not QUEUED: ${taskId} (${task.status})`);
    }

    const meta = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: taskPk(taskId), sk: 'META' },
      }),
    );
    if (meta.Item?.blocked) {
      throw new ReservationConflictError(`Task blocked: ${taskId}`);
    }

    const k8sJobName = deterministicJobName(task);
    const now = new Date().toISOString();
    const reservation: Reservation = {
      taskId: task.taskId,
      attempt: task.attempt,
      state: 'ACTIVE',
      k8sJobName,
      createdAt: now,
      lastObservedAt: now,
    };
    const nextTask: ReadyTask = {
      ...task,
      status: 'RESERVED',
      k8sJobName,
      version: task.version + 1,
    };

    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: CAPACITY_PK, sk: CAPACITY_SK },
                UpdateExpression: 'SET used = used + :one, version = version + :one',
                ConditionExpression: 'used < #limit',
                ExpressionAttributeNames: { '#limit': 'limit' },
                ExpressionAttributeValues: { ':one': 1 },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: taskPk(taskId), sk: 'META' },
                UpdateExpression:
                  'SET #task = :task, #status = :reserved REMOVE gsi1pk, gsi1sk',
                ConditionExpression: '#task.#status = :queued',
                ExpressionAttributeNames: {
                  '#task': 'task',
                  '#status': 'status',
                },
                ExpressionAttributeValues: {
                  ':task': nextTask,
                  ':reserved': 'RESERVED',
                  ':queued': 'QUEUED',
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: reservationPk(task.taskId, task.attempt),
                  sk: 'META',
                  entityType: 'RESERVATION',
                  reservation,
                  state: 'ACTIVE',
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        const capacityFail = reasons[0]?.Code === 'ConditionalCheckFailed';
        if (capacityFail) {
          throw new ReservationConflictError('Global capacity exhausted');
        }
        throw new ReservationConflictError(`Reserve conflict: ${taskId}`);
      }
      throw error;
    }
    return structuredClone(reservation);
  }

  async release(
    taskId: string,
    terminalStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED',
  ): Promise<'released' | 'already_released'> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const resKey = { pk: reservationPk(task.taskId, task.attempt), sk: 'META' };
    const existing = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: resKey }),
    );
    if (!existing.Item) {
      throw new Error(`Reservation not found: ${taskId}`);
    }
    const reservation = existing.Item.reservation as Reservation;
    if (reservation.state !== 'ACTIVE') {
      return 'already_released';
    }

    const finalStatus =
      terminalStatus === 'SUCCEEDED'
        ? 'FINALIZED'
        : terminalStatus === 'CANCELLED'
          ? 'CANCELLED'
          : terminalStatus;
    const releasedAt = new Date().toISOString();
    const nextReservation: Reservation = {
      ...reservation,
      state: 'RELEASED',
      releasedAt,
    };
    const nextTask: ReadyTask = {
      ...task,
      status: finalStatus,
      version: task.version + 1,
    };

    try {
      const items: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]
      >['TransactItems'] = [
        {
          Update: {
            TableName: this.tableName,
            Key: resKey,
            UpdateExpression: 'SET #reservation = :res, #state = :released',
            ConditionExpression: '#state = :active',
            ExpressionAttributeNames: {
              '#reservation': 'reservation',
              '#state': 'state',
            },
            ExpressionAttributeValues: {
              ':res': nextReservation,
              ':released': 'RELEASED',
              ':active': 'ACTIVE',
            },
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: { pk: CAPACITY_PK, sk: CAPACITY_SK },
            UpdateExpression: 'SET used = used - :one, version = version + :one',
            ConditionExpression: 'used >= :one',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: { pk: taskPk(taskId), sk: 'META' },
            UpdateExpression: 'SET #task = :task, #status = :status',
            ExpressionAttributeNames: {
              '#task': 'task',
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':task': nextTask,
              ':status': finalStatus,
            },
          },
        },
      ];

      if (terminalStatus === 'SUCCEEDED') {
        items.push({
          Put: {
            TableName: this.tableName,
            Item: {
              pk: completedPk(taskId),
              sk: 'META',
              entityType: 'COMPLETED',
              completedAt: releasedAt,
            },
          },
        });
      }

      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return 'released';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const again = await this.doc.send(
          new GetCommand({ TableName: this.tableName, Key: resKey }),
        );
        if ((again.Item?.reservation as Reservation | undefined)?.state !== 'ACTIVE') {
          return 'already_released';
        }
      }
      throw error;
    }
  }

  async activeReservationCount(): Promise<number> {
    const cap = await this.getCapacity();
    return cap.used;
  }

  async activeByStage(): Promise<Record<AgentStage, number>> {
    // Best-effort scan of active task statuses is expensive; capacity used is authoritative.
    // Stage soft-targets read from GSI/status in a follow-up; return zeros for soft policy.
    return { planner: 0, coding: 0, fix: 0 };
  }

  async capacitySnapshot(
    byStage: Record<AgentStage, number> = { planner: 0, coding: 0, fix: 0 },
  ): Promise<CapacitySnapshot> {
    const cap = await this.getCapacity();
    return {
      limit: cap.limit,
      used: cap.used,
      available: Math.max(0, cap.limit - cap.used),
      version: cap.version,
      byStage,
    };
  }

  async setCapacityLimit(limit: number): Promise<void> {
    await this.ensureCapacityInitialized();
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: CAPACITY_PK, sk: CAPACITY_SK },
        UpdateExpression: 'SET #limit = :limit, version = version + :one',
        ExpressionAttributeNames: { '#limit': 'limit' },
        ExpressionAttributeValues: { ':limit': limit, ':one': 1 },
      }),
    );
  }

  async listActiveReservationsMissingSchedule(): Promise<
    Array<{ task: ReadyTask; reservation: Reservation }>
  > {
    // Production reconciler should query RESERVED tasks via a dedicated GSI.
    // Minimal P7: empty until status GSI lands.
    return [];
  }

  async countByStatus(status: ReadyTask['status']): Promise<number> {
    if (status === 'QUEUED') {
      return (await this.listQueued()).length;
    }
    if (status === 'RESERVED' || status === 'SCHEDULED' || status === 'RUNNING') {
      return status === 'RESERVED' ? await this.activeReservationCount() : 0;
    }
    return 0;
  }

  private async getApprovedSpecHash(workflowId: string): Promise<string | undefined> {
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: approvedPk(workflowId), sk: 'META' },
      }),
    );
    const hash = result.Item?.specHash;
    return typeof hash === 'string' ? hash : undefined;
  }

  private async getCapacity(): Promise<{ used: number; limit: number; version: number }> {
    await this.ensureCapacityInitialized();
    const result = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: CAPACITY_PK, sk: CAPACITY_SK },
      }),
    );
    return {
      used: Number(result.Item?.used ?? 0),
      limit: Number(result.Item?.limit ?? this.config.globalMaxConcurrentJobs),
      version: Number(result.Item?.version ?? 1),
    };
  }

  private async setTaskStatus(
    taskId: string,
    from: ReadyTask['status'],
    to: ReadyTask['status'],
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.status !== from) {
      throw new ReservationConflictError(`Cannot mark ${to}: ${taskId}`);
    }
    const next = { ...task, status: to, version: task.version + 1 };
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: taskPk(taskId), sk: 'META' },
        UpdateExpression: 'SET #task = :task, #status = :status',
        ConditionExpression: '#task.#status = :from',
        ExpressionAttributeNames: {
          '#task': 'task',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':task': next,
          ':status': to,
          ':from': from,
        },
      }),
    );
  }
}
