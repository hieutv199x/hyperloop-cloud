import type { WorkflowRecord } from '../../domain/types.js';

export class ConditionalWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionalWriteError';
  }
}

export interface WorkflowRepository {
  getById(workflowId: string): Promise<WorkflowRecord | null>;
  createIfAbsent(workflow: WorkflowRecord): Promise<'created' | 'exists'>;
  updateConditional(
    workflow: WorkflowRecord,
    expectedVersion: number,
  ): Promise<void>;
  recordEventOnce(eventId: string, workflowId: string): Promise<'recorded' | 'duplicate'>;
  listTimeline(workflowId: string): Promise<WorkflowRecord['timeline']>;
}

export function buildWorkflowId(userStory: string, revision: number): string {
  return `WF#${userStory}#${revision}`;
}

export function buildPlannerJobName(workflowId: string): string {
  const safe = workflowId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 40);
  return `hl-planner-${safe}`.slice(0, 63);
}
