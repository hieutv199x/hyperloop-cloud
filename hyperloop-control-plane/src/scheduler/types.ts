import type { AgentStage } from './config.js';

export type TaskStatus =
  | 'QUEUED'
  | 'RESERVED'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'FINALIZED'
  | 'CANCELLED';

export type ReservationState = 'ACTIVE' | 'RELEASED' | 'ABANDONED';

export interface ReadyTask {
  taskId: string;
  workflowId: string;
  stage: AgentStage;
  repository?: string;
  project?: string;
  priority: number;
  readyAt: string;
  attempt: number;
  status: TaskStatus;
  version: number;
  approvedSpecHash?: string;
  k8sJobName?: string;
  dependsOn?: string[];
}

export interface Reservation {
  taskId: string;
  attempt: number;
  state: ReservationState;
  k8sJobName: string;
  createdAt: string;
  lastObservedAt?: string;
  releasedAt?: string;
}

export interface CapacitySnapshot {
  limit: number;
  used: number;
  available: number;
  version: number;
  byStage: Record<AgentStage, number>;
}

export interface EnqueueTaskInput {
  taskId: string;
  workflowId: string;
  stage: AgentStage;
  repository?: string;
  project?: string;
  attempt?: number;
  approvedSpecHash?: string;
  dependsOn?: string[];
  /** When false, task is stored but not dispatchable (e.g. waiting HITL). */
  dispatchable?: boolean;
}
