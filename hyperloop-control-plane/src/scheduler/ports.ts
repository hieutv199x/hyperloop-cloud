import type { AgentStage } from './config.js';
import type { CapacitySnapshot, EnqueueTaskInput, ReadyTask, Reservation } from './types.js';
import type { PriorityPolicy } from './priority-policy.js';

/**
 * Durable ready-job intents (DynamoDB QUEUED + GSI) and related lifecycle.
 * In-memory AtomicSchedulerStore remains the unit-test implementation.
 */
export interface ReadyJobRepository {
  enqueue(input: EnqueueTaskInput, policy: PriorityPolicy): Promise<ReadyTask>;
  listQueued(): Promise<ReadyTask[]>;
  getTask(taskId: string): Promise<ReadyTask | undefined>;
  cancelQueued(taskId: string): Promise<void>;
  markScheduled(taskId: string): Promise<void>;
  markRunning(taskId: string): Promise<void>;
  markSpecApproved(workflowId: string, specHash: string): Promise<void>;
  clearSpecApproval(workflowId: string): Promise<void>;
}

/**
 * Global 100-slot admission via DynamoDB TransactWriteItems
 * (counter item + reservation item, release-once).
 */
export interface ConcurrencySemaphore {
  reserve(taskId: string): Promise<Reservation>;
  release(
    taskId: string,
    terminalStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED',
  ): Promise<'released' | 'already_released'>;
  activeReservationCount(): Promise<number>;
  activeByStage(): Promise<Record<AgentStage, number>>;
  capacitySnapshot(byStage?: Record<AgentStage, number>): Promise<CapacitySnapshot>;
  setCapacityLimit(limit: number): Promise<void>;
}

export interface SchedulerStorePort extends ReadyJobRepository, ConcurrencySemaphore {
  listActiveReservationsMissingSchedule(): Promise<
    Array<{ task: ReadyTask; reservation: Reservation }>
  >;
  countByStatus(status: ReadyTask['status']): Promise<number>;
}

export interface SchedulerQueuePort {
  publish(stage: AgentStage, taskId: string): Promise<void>;
  /** Receive wake-ups; when capacityFull, do not extend visibility — delete or release. */
  receive(
    stage: AgentStage,
    max: number,
    capacityFull: boolean,
  ): Promise<Array<{ taskId: string; receiptHandle?: string }>>;
  ack?(receiptHandle: string): Promise<void>;
}
