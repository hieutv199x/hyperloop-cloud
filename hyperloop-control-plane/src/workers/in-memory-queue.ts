import type { AgentStage } from '../scheduler/config.js';

export interface WakeUpMessage {
  messageId: string;
  taskId: string;
  stage: AgentStage;
  receivedCount: number;
}

/**
 * SQS wake-up analogue. Ack after durable enqueue — never held for full runtime.
 */
export class InMemoryQueueBus {
  private readonly queues = new Map<AgentStage, WakeUpMessage[]>();
  private readonly dlq = new Map<AgentStage, WakeUpMessage[]>();
  private seq = 0;
  pollCallsWhenFull = 0;

  constructor(stages: AgentStage[] = ['planner', 'coding', 'fix']) {
    for (const stage of stages) {
      this.queues.set(stage, []);
      this.dlq.set(stage, []);
    }
  }

  publish(stage: AgentStage, taskId: string): string {
    const messageId = `msg-${++this.seq}`;
    this.queues.get(stage)!.push({
      messageId,
      taskId,
      stage,
      receivedCount: 0,
    });
    return messageId;
  }

  /**
   * Receive up to N messages. When capacityFull, suppress busy polling.
   */
  receive(stage: AgentStage, max = 10, capacityFull = false): WakeUpMessage[] {
    if (capacityFull) {
      this.pollCallsWhenFull += 1;
      return [];
    }
    const queue = this.queues.get(stage)!;
    const batch = queue.splice(0, max);
    for (const msg of batch) {
      msg.receivedCount += 1;
    }
    return batch;
  }

  /** Simulate lost wake-up (message dropped, durable task remains in store). */
  dropAll(stage: AgentStage): number {
    const queue = this.queues.get(stage)!;
    const n = queue.length;
    queue.length = 0;
    return n;
  }

  sendToDlq(message: WakeUpMessage): void {
    this.dlq.get(message.stage)!.push(message);
  }

  depth(stage: AgentStage): number {
    return this.queues.get(stage)?.length ?? 0;
  }

  dlqDepth(stage: AgentStage): number {
    return this.dlq.get(stage)?.length ?? 0;
  }

  depths(): Record<AgentStage, number> {
    return {
      planner: this.depth('planner'),
      coding: this.depth('coding'),
      fix: this.depth('fix'),
    };
  }
}

export class QueuePublisher {
  constructor(private readonly bus: InMemoryQueueBus) {}

  async publishReady(stage: AgentStage, taskId: string): Promise<string> {
    return this.bus.publish(stage, taskId);
  }
}
