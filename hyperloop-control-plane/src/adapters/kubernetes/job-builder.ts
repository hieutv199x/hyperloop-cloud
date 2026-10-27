import {
  resolveAgentImage,
  type AgentImageSet,
  type AgentRole,
} from './agent-images.js';
import type { DesiredJobSpec } from './types.js';

export interface AgentJobBuildInput {
  name: string;
  namespace: string;
  /** Explicit image; otherwise resolved from images[stage]. */
  image?: string;
  images?: AgentImageSet;
  imageAllowlist?: ReadonlySet<string>;
  workflowId: string;
  jobId: string;
  stage: AgentRole;
  attempt?: number;
  sddCommitSha?: string;
  /** S3 (or file) URI of the immutable AgentExecutionContract JSON. */
  contractUri?: string;
  executionId?: string;
  extraEnv?: Record<string, string>;
  activeDeadlineSeconds?: number;
  ttlSecondsAfterFinished?: number;
}

export function buildAgentJobSpec(input: AgentJobBuildInput): DesiredJobSpec {
  const image =
    input.image ??
    resolveAgentImage(
      input.stage,
      input.images ?? {
        planner: '',
        coding: '',
        fix: '',
      },
      input.imageAllowlist,
    );
  if (!image) {
    throw new Error(`Agent image required for stage ${input.stage}`);
  }

  return {
    name: input.name,
    namespace: input.namespace,
    image,
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
      HYPERLOOP_ROLE: input.stage,
      HYPERLOOP_ATTEMPT: String(input.attempt ?? 1),
      /** Contract mounted at /hyperloop/contract.json in the Job Pod (from this URI). */
      HYPERLOOP_CONTRACT_PATH: '/hyperloop/contract.json',
      ...(input.sddCommitSha ? { HYPERLOOP_SDD_COMMIT_SHA: input.sddCommitSha } : {}),
      ...(input.contractUri ? { HYPERLOOP_CONTRACT_URI: input.contractUri } : {}),
      ...(input.executionId ? { HYPERLOOP_EXECUTION_ID: input.executionId } : {}),
      ...input.extraEnv,
    },
    activeDeadlineSeconds: input.activeDeadlineSeconds ?? 1800,
    ttlSecondsAfterFinished: input.ttlSecondsAfterFinished ?? 600,
  };
}
