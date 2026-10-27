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

const allowedTransitions: Record<WorkflowState, readonly WorkflowState[]> = {
  SUBMITTED: ['PLANNING', 'NEEDS_SPEC_CLARIFICATION', 'CANCELLED', 'FAILED'],
  PLANNING: ['WAITING_SPEC_APPROVAL', 'NEEDS_SPEC_CLARIFICATION', 'FAILED', 'CANCELLED'],
  NEEDS_SPEC_CLARIFICATION: ['PLANNING', 'SUBMITTED', 'CANCELLED'],
  WAITING_SPEC_APPROVAL: ['CODING', 'SPEC_CHANGES_REQUESTED', 'CANCELLED', 'PLANNING'],
  SPEC_CHANGES_REQUESTED: ['PLANNING', 'CANCELLED'],
  CODING: ['AWAITING_CI', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN', 'PLANNING'],
  AWAITING_CI: ['FIXING', 'READY_FOR_REVIEW', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED'],
  FIXING: ['AWAITING_CI', 'NEEDS_HUMAN', 'FAILED', 'CANCELLED'],
  READY_FOR_REVIEW: ['MERGED', 'CANCELLED', 'NEEDS_HUMAN'],
  MERGED: ['COMPLETED'],
  COMPLETED: [],
  NEEDS_HUMAN: ['CANCELLED', 'CODING', 'FIXING', 'PLANNING'],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal workflow transition: ${from} -> ${to}`);
  }
}
