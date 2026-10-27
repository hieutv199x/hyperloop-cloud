import type { DesiredJobSpec } from './types.js';

export interface AgentJobBuildInput {
  name: string;
  namespace: string;
  image: string;
  workflowId: string;
  jobId: string;
  stage: 'planner' | 'coding' | 'fix';
  attempt?: number;
  sddCommitSha?: string;
  extraEnv?: Record<string, string>;
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
}

export function buildAgentJobSpec(input: AgentJobBuildInput): DesiredJobSpec {
  return {
    name: input.name,
    namespace: input.namespace,
    image: input.image,
    labels: {
      'app.kubernetes.io/part-of': 'hyperloop',
      'hyperloop.dev/workflow-id': input.workflowId,
      'hyperloop.dev/job-id': input.jobId,
      'hyperloop.dev/stage': input.stage,
      'hyperloop.dev/attempt': String(input.attempt ?? 1),
    },
    env: {
      HYPERLOOP_WORKFLOW_ID: input.workflowId,
      HYPERLOOP_JOB_ID: input.jobId,
      HYPERLOOP_STAGE: input.stage,
      HYPERLOOP_ATTEMPT: String(input.attempt ?? 1),
      ...(input.sddCommitSha ? { HYPERLOOP_SDD_COMMIT_SHA: input.sddCommitSha } : {}),
      ...input.extraEnv,
    },
    activeDeadlineSeconds: input.activeDeadlineSeconds ?? 1800,
    ttlSecondsAfterFinished: input.ttlSecondsAfterFinished ?? 600,
  };
}
