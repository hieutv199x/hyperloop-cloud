import type { NormalizedWorkflowEvent } from '../events/event-bus.js';

export function buildWorkflowId(userStory: string, revision: number): string {
  return `WF#${userStory}#${revision}`;
}

export function normalizeSddSubmitted(input: {
  eventId: string;
  occurredAt: string;
  project: string;
  userStory: string;
  revision: number;
  sddCommitSha: string;
  sddPath: string;
  changedPaths?: string[];
  sddProject?: string;
  devSpec: unknown;
}): NormalizedWorkflowEvent {
  const workflowId = buildWorkflowId(input.userStory, input.revision);
  return {
    eventId: input.eventId,
    eventType: 'SDD_REVISION_SUBMITTED',
    occurredAt: input.occurredAt,
    workflowId,
    correlationId: input.eventId,
    schemaVersion: '1.0.0',
    payload: {
      project: input.project,
      sddProject: input.sddProject ?? input.project,
      userStory: input.userStory,
      revision: input.revision,
      sddCommitSha: input.sddCommitSha,
      sddPath: input.sddPath,
      changedPaths: input.changedPaths ?? [input.sddPath],
      devSpec: input.devSpec,
    },
  };
}

export function normalizeCiResult(input: {
  eventId: string;
  occurredAt: string;
  workflowId: string;
  repository: string;
  mrIid: number;
  commitSha: string;
  pipelineId: string;
  status: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE';
  buildId?: string;
  gateFailures?: Array<{
    gate: string;
    classification: 'fixable' | 'non_fixable';
    message: string;
  }>;
  reportUri?: string;
  logUri?: string;
}): NormalizedWorkflowEvent {
  return {
    eventId: input.eventId,
    eventType: 'CI_RESULT_RECEIVED',
    occurredAt: input.occurredAt,
    workflowId: input.workflowId,
    correlationId: input.eventId,
    schemaVersion: '1.0.0',
    payload: {
      workflowId: input.workflowId,
      repository: input.repository,
      mrIid: input.mrIid,
      commitSha: input.commitSha,
      pipelineId: input.pipelineId,
      status: input.status,
      buildId: input.buildId,
      gateFailures: input.gateFailures,
      reportUri: input.reportUri,
      logUri: input.logUri,
    },
  };
}

export function normalizeMrMerged(input: {
  eventId: string;
  occurredAt: string;
  workflowId: string;
  repository: string;
  mrIid: number;
  mergeCommitSha: string;
}): NormalizedWorkflowEvent {
  return {
    eventId: input.eventId,
    eventType: 'MR_MERGED',
    occurredAt: input.occurredAt,
    workflowId: input.workflowId,
    correlationId: input.eventId,
    schemaVersion: '1.0.0',
    payload: { ...input },
  };
}
