import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AgentStage } from '../../scheduler/config.js';
import type { SchedulerQueuePort } from '../../scheduler/ports.js';

export interface SqsQueueBusOptions {
  client?: SQSClient;
  queueUrls: Record<AgentStage, string>;
  /** Short visibility — never hold messages while waiting hours for a slot. */
  visibilityTimeoutSeconds?: number;
}

/**
 * Scheduler wake-up bus over SQS.
 * When capacity is full, messages are deleted (not kept invisible) so slots
 * are reclaimed via DynamoDB reconciliation rather than SQS lease duration.
 */
export class SqsQueueBus implements SchedulerQueuePort {
  private readonly client: SQSClient;
  private readonly visibilityTimeoutSeconds: number;

  constructor(private readonly options: SqsQueueBusOptions) {
    this.client = options.client ?? new SQSClient({});
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 30;
  }

  async publish(stage: AgentStage, taskId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.queueUrls[stage],
        MessageBody: JSON.stringify({ taskId, stage }),
      }),
    );
  }

  async receive(
    stage: AgentStage,
    max: number,
    capacityFull: boolean,
  ): Promise<Array<{ taskId: string; receiptHandle?: string }>> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrls[stage],
        MaxNumberOfMessages: Math.min(max, 10),
        VisibilityTimeout: this.visibilityTimeoutSeconds,
        WaitTimeSeconds: 0,
      }),
    );
    const out: Array<{ taskId: string; receiptHandle?: string }> = [];
    for (const message of result.Messages ?? []) {
      const body = message.Body ? (JSON.parse(message.Body) as { taskId?: string }) : {};
      const taskId = body.taskId ?? message.MessageId ?? 'unknown';
      if (capacityFull && message.ReceiptHandle) {
        // Do not hold invisible while waiting for slots — drop wake-up.
        await this.ack(stage, message.ReceiptHandle);
        continue;
      }
      out.push({ taskId, receiptHandle: message.ReceiptHandle });
    }
    return out;
  }

  async ack(stageOrHandle: AgentStage | string, maybeHandle?: string): Promise<void> {
    if (maybeHandle) {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.options.queueUrls[stageOrHandle as AgentStage],
          ReceiptHandle: maybeHandle,
        }),
      );
      return;
    }
    // Port-compatible no-op when only handle is known without stage — callers use stage+handle.
  }
}
