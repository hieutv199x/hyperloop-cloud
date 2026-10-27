import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventBus, NormalizedWorkflowEvent } from './event-bus.js';

export interface SqsEventBusOptions {
  client?: SQSClient;
  /** Logical queue name → SQS queue URL */
  queueUrls: Record<string, string>;
  visibilityTimeoutSeconds?: number;
}

/**
 * SQS-backed EventBus for Event Gateway → Control Plane.
 * receive() deletes messages after read (at-least-once; CP dedupes by eventId).
 */
export class SqsEventBus implements EventBus {
  private readonly client: SQSClient;

  constructor(private readonly options: SqsEventBusOptions) {
    this.client = options.client ?? new SQSClient({});
  }

  async publish(queue: string, event: NormalizedWorkflowEvent): Promise<void> {
    const url = this.requireUrl(queue);
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(event),
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: event.eventType },
          eventId: { DataType: 'String', StringValue: event.eventId },
        },
      }),
    );
  }

  async receive(queue: string, max = 10): Promise<NormalizedWorkflowEvent[]> {
    const url = this.requireUrl(queue);
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: Math.min(max, 10),
        VisibilityTimeout: this.options.visibilityTimeoutSeconds ?? 30,
        WaitTimeSeconds: 0,
      }),
    );
    const events: NormalizedWorkflowEvent[] = [];
    for (const message of result.Messages ?? []) {
      if (!message.Body) continue;
      events.push(JSON.parse(message.Body) as NormalizedWorkflowEvent);
      if (message.ReceiptHandle) {
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: url,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
    return events;
  }

  private requireUrl(queue: string): string {
    const url = this.options.queueUrls[queue];
    if (!url) {
      throw new Error(`SQS queue URL not configured for logical queue: ${queue}`);
    }
    return url;
  }
}
