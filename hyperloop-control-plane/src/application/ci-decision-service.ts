import type { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import type { ServiceExecution, WorkflowRecord } from '../domain/types.js';
import { assertTransition } from '../domain/workflow-states.js';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';

export interface CiResultInput {
  eventId: string;
  workflowId: string;
  repository: string;
  mrIid: number;
  commitSha: string;
  pipelineId: string;
  status: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE';
  gateFailures?: Array<{
    gate: string;
    classification: 'fixable' | 'non_fixable';
    message: string;
  }>;
  reportUri?: string;
  /** Override max auto-fix attempts (default 2 per Section 0). */
  maxAutoFixAttempts?: number;
}

export interface MrMergedInput {
  eventId: string;
  workflowId: string;
  repository: string;
  mrIid: number;
  mergeCommitSha: string;
}

export type CiDecisionOutcome =
  | {
      action: 'noop';
      reason:
        | 'stale_sha'
        | 'mr_mismatch'
        | 'duplicate_pipeline'
        | 'unknown_service'
        | 'workflow_not_found'
        | 'wrong_state';
    }
  | { action: 'pass'; workflow: WorkflowRecord }
  | { action: 'fix_enqueued'; workflow: WorkflowRecord; taskId: string }
  | { action: 'needs_human'; workflow: WorkflowRecord; reason: string };

export type MergeDecisionOutcome =
  | { action: 'noop'; reason: string }
  | { action: 'service_merged'; workflow: WorkflowRecord }
  | { action: 'workflow_completed'; workflow: WorkflowRecord };

/**
 * M5 / P8: correlate Jenkins CI callbacks and GitLab MR merges.
 */
export class CiDecisionService {
  constructor(
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly scheduler: JobQueueScheduler,
  ) {}

  async handleCiResult(input: CiResultInput): Promise<CiDecisionOutcome> {
    const workflow = await this.orchestrator.getWorkflow(input.workflowId);
    if (!workflow) {
      return { action: 'noop', reason: 'workflow_not_found' };
    }
    const service = workflow.services[input.repository];
    if (!service) {
      return { action: 'noop', reason: 'unknown_service' };
    }
    if (service.mrIid != null && service.mrIid !== input.mrIid) {
      return { action: 'noop', reason: 'mr_mismatch' };
    }
    if (service.expectedCommitSha && service.expectedCommitSha !== input.commitSha) {
      return { action: 'noop', reason: 'stale_sha' };
    }
    const seen = service.seenPipelineIds ?? [];
    if (seen.includes(input.pipelineId)) {
      return { action: 'noop', reason: 'duplicate_pipeline' };
    }
    if (service.state !== 'AWAITING_CI' && service.state !== 'FIXING') {
      return { action: 'noop', reason: 'wrong_state' };
    }

    service.seenPipelineIds = [...seen, input.pipelineId];
    if (input.reportUri) service.lastCiReportUri = input.reportUri;

    if (input.status === 'SUCCESS') {
      return this.onPass(workflow, service, input);
    }
    return this.onFail(workflow, service, input);
  }

  async handleMrMerged(input: MrMergedInput): Promise<MergeDecisionOutcome> {
    const workflow = await this.orchestrator.getWorkflow(input.workflowId);
    if (!workflow) {
      return { action: 'noop', reason: 'workflow_not_found' };
    }
    const service = workflow.services[input.repository];
    if (!service) {
      return { action: 'noop', reason: 'unknown_service' };
    }
    if (service.mrIid != null && service.mrIid !== input.mrIid) {
      return { action: 'noop', reason: 'mr_mismatch' };
    }
    if (service.state === 'MERGED') {
      return { action: 'noop', reason: 'already_merged' };
    }
    if (service.state !== 'READY') {
      return { action: 'noop', reason: `service_not_ready:${service.state}` };
    }

    const expectedVersion = workflow.version;
    const now = new Date().toISOString();
    service.state = 'MERGED';
    service.mergeCommitSha = input.mergeCommitSha;
    workflow.timeline.push({
      at: now,
      type: 'SERVICE_MERGED',
      detail: `${input.repository} mr=${input.mrIid}`,
    });

    const allMerged = Object.values(workflow.services).every((s) => s.state === 'MERGED');
    if (allMerged && workflow.status === 'READY_FOR_REVIEW') {
      assertTransition(workflow.status, 'MERGED');
      workflow.status = 'MERGED';
      assertTransition(workflow.status, 'COMPLETED');
      workflow.status = 'COMPLETED';
      workflow.timeline.push({ at: now, type: 'WORKFLOW_COMPLETED' });
      workflow.version += 1;
      workflow.updatedAt = now;
      await this.orchestrator.saveConditional(workflow, expectedVersion);
      return { action: 'workflow_completed', workflow };
    }

    workflow.version += 1;
    workflow.updatedAt = now;
    await this.orchestrator.saveConditional(workflow, expectedVersion);
    return { action: 'service_merged', workflow };
  }

  private async onPass(
    workflow: WorkflowRecord,
    service: ServiceExecution,
    input: CiResultInput,
  ): Promise<CiDecisionOutcome> {
    const expectedVersion = workflow.version;
    const now = new Date().toISOString();
    service.state = 'READY';
    workflow.timeline.push({
      at: now,
      type: 'CI_PASSED',
      detail: `${input.repository}@${input.commitSha} pipeline=${input.pipelineId}`,
    });

    const allReady = Object.values(workflow.services).every(
      (s) => s.state === 'READY' || s.state === 'MERGED',
    );
    if (allReady && (workflow.status === 'AWAITING_CI' || workflow.status === 'FIXING')) {
      assertTransition(workflow.status, 'READY_FOR_REVIEW');
      workflow.status = 'READY_FOR_REVIEW';
      workflow.timeline.push({ at: now, type: 'READY_FOR_REVIEW' });
    }

    workflow.version += 1;
    workflow.updatedAt = now;
    await this.orchestrator.saveConditional(workflow, expectedVersion);
    return { action: 'pass', workflow };
  }

  private async onFail(
    workflow: WorkflowRecord,
    service: ServiceExecution,
    input: CiResultInput,
  ): Promise<CiDecisionOutcome> {
    const expectedVersion = workflow.version;
    const now = new Date().toISOString();
    const maxFix = input.maxAutoFixAttempts ?? 2;
    const gates = input.gateFailures ?? [];
    const hasFixable = gates.some((g) => g.classification === 'fixable');
    const hasNonFixable = gates.some((g) => g.classification === 'non_fixable');
    const canAutoFix =
      input.status === 'FAILURE' &&
      hasFixable &&
      !hasNonFixable &&
      service.fixAttempts < maxFix;

    if (canAutoFix) {
      service.fixAttempts += 1;
      service.state = 'FIXING';
      if (workflow.status === 'AWAITING_CI') {
        assertTransition(workflow.status, 'FIXING');
        workflow.status = 'FIXING';
      }
      const taskId = `${workflow.workflowId}:fix:${input.repository}:${service.fixAttempts}`;
      workflow.desiredJobs.push({
        jobId: taskId,
        stage: 'fix',
        status: 'JOB_DESIRED',
        repository: input.repository,
        createdAt: now,
        k8sJobName: `hl-fix-${input.repository}-${service.fixAttempts}`.slice(0, 63),
      });
      workflow.timeline.push({
        at: now,
        type: 'FIX_ENQUEUED',
        detail: `${taskId}; pipeline=${input.pipelineId}`,
      });
      workflow.version += 1;
      workflow.updatedAt = now;
      await this.orchestrator.saveConditional(workflow, expectedVersion);

      if (workflow.specHash) {
        this.scheduler.store.markSpecApproved(workflow.workflowId, workflow.specHash);
      }
      await this.scheduler.enqueue({
        taskId,
        workflowId: workflow.workflowId,
        stage: 'fix',
        repository: input.repository,
        project: workflow.project,
        approvedSpecHash: workflow.specHash,
        attempt: service.fixAttempts,
      });
      return { action: 'fix_enqueued', workflow, taskId };
    }

    service.state = 'NEEDS_HUMAN';
    if (workflow.status === 'AWAITING_CI' || workflow.status === 'FIXING') {
      assertTransition(workflow.status, 'NEEDS_HUMAN');
      workflow.status = 'NEEDS_HUMAN';
    }
    const reason =
      input.status === 'ABORTED' || input.status === 'UNSTABLE'
        ? `ci_${input.status.toLowerCase()}`
        : hasNonFixable
          ? 'non_fixable_gate'
          : service.fixAttempts >= maxFix
            ? 'fix_exhausted'
            : 'ci_failure';
    workflow.timeline.push({
      at: now,
      type: 'NEEDS_HUMAN',
      detail: `${input.repository}; ${reason}; pipeline=${input.pipelineId}`,
    });
    workflow.version += 1;
    workflow.updatedAt = now;
    await this.orchestrator.saveConditional(workflow, expectedVersion);
    return { action: 'needs_human', workflow, reason };
  }
}
