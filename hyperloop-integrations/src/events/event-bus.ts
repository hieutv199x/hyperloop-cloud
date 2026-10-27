export interface NormalizedWorkflowEvent {
  eventId: string;
  eventType: 'SDD_REVISION_SUBMITTED' | 'CI_RESULT_RECEIVED' | 'MR_MERGED';
  occurredAt: string;
  workflowId: string;
  correlationId: string;
  schemaVersion: '1.0.0';
  payload: Record<string, unknown>;
}

export interface EventBus {
  publish(queue: string, event: NormalizedWorkflowEvent): Promise<void>;
  receive(queue: string, max?: number): Promise<NormalizedWorkflowEvent[]>;
}

/**
 * In-memory stand-in for SQS `devspec-events` (+ siblings).
 * Publish failure must surface so the gateway can return 503 for retries.
 */
export class InMemoryEventBus implements EventBus {
  readonly queues = new Map<string, NormalizedWorkflowEvent[]>();
  readonly published: NormalizedWorkflowEvent[] = [];
  failNextPublish = false;

  async publish(queue: string, event: NormalizedWorkflowEvent): Promise<void> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('SQS publish failed');
    }
    const bucket = this.queues.get(queue) ?? [];
    bucket.push(event);
    this.queues.set(queue, bucket);
    this.published.push(event);
  }

  async receive(queue: string, max = 10): Promise<NormalizedWorkflowEvent[]> {
    const bucket = this.queues.get(queue) ?? [];
    const batch = bucket.splice(0, max);
    this.queues.set(queue, bucket);
    return batch;
  }

  depth(queue: string): number {
    return this.queues.get(queue)?.length ?? 0;
  }
}

export const DEVSPEC_EVENTS_QUEUE = 'devspec-events';
