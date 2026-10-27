export const WorkflowStates = [
  'SUBMITTED',
  'PLANNING',
  'NEEDS_SPEC_CLARIFICATION',
  'WAITING_SPEC_APPROVAL',
  'SPEC_CHANGES_REQUESTED',
  'CODING',
  'AWAITING_CI',
  'FIXING',
  'READY_FOR_REVIEW',
  'MERGED',
  'COMPLETED',
  'NEEDS_HUMAN',
  'CANCELLED',
  'FAILED',
] as const;

export type WorkflowState = (typeof WorkflowStates)[number];

export const TaskStates = [
  'QUEUED',
  'RESERVED',
  'SCHEDULED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'FINALIZED',
  'CANCELLED',
] as const;

export type TaskState = (typeof TaskStates)[number];

export const AgentStages = ['planner', 'coding', 'fix'] as const;
export type AgentStage = (typeof AgentStages)[number];
