import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import {
  DEFAULT_AGENT_IMAGES,
  type AgentImageSet,
} from '../adapters/kubernetes/agent-images.js';
import { buildAgentJobSpec } from '../adapters/kubernetes/job-builder.js';
import {
  buildPlannerJobName,
  buildWorkflowId,
  ConditionalWriteError,
  type WorkflowRepository,
} from '../adapters/dynamodb/workflow-repository.js';
import { assertTransition } from '../domain/workflow-states.js';
import type {
  ApproveSpecInput,
  PlanServiceNode,
  SubmitDevSpecInput,
  SubmitDevSpecResult,
  WorkflowRecord,
} from '../domain/types.js';
import {
  ApproverPolicy,
  type ApproverIdentity,
} from '../security/approver-policy.js';

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface OrchestratorDeps {
  repository: WorkflowRepository;
  kubernetes: KubernetesJobPort;
  agentNamespace: string;
  /** @deprecated Use agentImages.planner */
  agentImage?: string;
  agentImages?: AgentImageSet;
  agentImageAllowlist?: ReadonlySet<string>;
  webhookSecret?: string;
  approverPolicy?: ApproverPolicy;
  /** Called when a new plan hash invalidates prior approvals (HITL re-bind). */
  onApprovalsInvalidated?: (workflowId: string) => void;
  now?: () => Date;
}

export class WorkflowOrchestrator {
  private readonly now: () => Date;
  private readonly approverPolicy: ApproverPolicy;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.approverPolicy = deps.approverPolicy ?? ApproverPolicy.allowAllForDev();
  }

  async submitDevSpec(input: SubmitDevSpecInput): Promise<SubmitDevSpecResult> {
    if (this.deps.webhookSecret) {
      if (!input.webhookSecret || input.webhookSecret !== this.deps.webhookSecret) {
        return { outcome: 'rejected', reason: 'Unauthorized webhook', statusCode: 401 };
      }
    }

    if (input.devSpec.spec.status !== 'submitted') {
      return {
        outcome: 'rejected',
        reason: `DEV-Spec status must be submitted, got ${input.devSpec.spec.status}`,
        statusCode: 400,
      };
    }

    for (const target of input.devSpec.spec.targets) {
      if (!/^release\/\d+\.\d+\.\d+$/.test(target.targetBranch)) {
        return {
          outcome: 'rejected',
          reason: `Invalid targetBranch: ${target.targetBranch}`,
          statusCode: 400,
        };
      }
    }

    const workflowId = buildWorkflowId(input.userStory, input.revision);
    const eventResult = await this.deps.repository.recordEventOnce(input.eventId, workflowId);
    if (eventResult === 'duplicate') {
      const existing = await this.deps.repository.getById(workflowId);
      if (!existing) {
        return {
          outcome: 'rejected',
          reason: 'Duplicate event without workflow',
          statusCode: 409,
        };
      }
      return { outcome: 'duplicate', workflow: existing };
    }

    const timestamp = this.now().toISOString();
    const plannerJobId = `${workflowId}:planner:1`;
    const k8sJobName = buildPlannerJobName(workflowId);
    const needsClarification = (input.clarificationIssues?.length ?? 0) > 0;

    const workflow: WorkflowRecord = {
      workflowId,
      project: input.project,
      userStory: input.userStory,
      revision: input.revision,
      status: 'SUBMITTED',
      version: 1,
      sddProject: input.sddProject ?? input.project,
      sddCommitSha: input.sddCommitSha,
      sddPath: input.sddPath,
      targets: input.devSpec.spec.targets,
      services: {},
      approvals: [],
      desiredJobs: needsClarification
        ? []
        : [
            {
              jobId: plannerJobId,
              stage: 'planner',
              status: 'JOB_DESIRED',
              createdAt: timestamp,
              k8sJobName,
            },
          ],
      createdAt: timestamp,
      updatedAt: timestamp,
      timeline: [
        {
          at: timestamp,
          type: 'DEV_SPEC_SUBMITTED',
          detail: `eventId=${input.eventId}; sdd=${input.sddCommitSha}`,
        },
      ],
    };

    const created = await this.deps.repository.createIfAbsent(workflow);
    if (created === 'exists') {
      const existing = await this.deps.repository.getById(workflowId);
      return { outcome: 'duplicate', workflow: existing! };
    }

    if (needsClarification) {
      assertTransition('SUBMITTED', 'NEEDS_SPEC_CLARIFICATION');
      workflow.status = 'NEEDS_SPEC_CLARIFICATION';
      workflow.clarificationIssues = input.clarificationIssues;
      workflow.version = 2;
      workflow.updatedAt = this.now().toISOString();
      workflow.timeline.push({
        at: workflow.updatedAt,
        type: 'NEEDS_SPEC_CLARIFICATION',
        detail: (input.clarificationIssues ?? []).map((i) => i.code).join(','),
      });
      await this.deps.repository.updateConditional(workflow, 1);
      return { outcome: 'created', workflow };
    }

    assertTransition('SUBMITTED', 'PLANNING');
    workflow.status = 'PLANNING';
    workflow.version = 2;
    workflow.updatedAt = this.now().toISOString();
    workflow.timeline.push({
      at: workflow.updatedAt,
      type: 'PLANNER_JOB_DESIRED',
      detail: plannerJobId,
    });
    await this.deps.repository.updateConditional(workflow, 1);

    const images = this.deps.agentImages ?? {
      ...DEFAULT_AGENT_IMAGES,
      ...(this.deps.agentImage ? { planner: this.deps.agentImage } : {}),
    };
    await this.deps.kubernetes.createJob(
      buildAgentJobSpec({
        name: k8sJobName,
        namespace: this.deps.agentNamespace,
        images,
        imageAllowlist: this.deps.agentImageAllowlist,
        workflowId,
        jobId: plannerJobId,
        stage: 'planner',
        sddCommitSha: input.sddCommitSha,
      }),
    );

    return { outcome: 'created', workflow };
  }

  async completePlanner(
    workflowId: string,
    input: {
      specHash: string;
      implementationSpecUri: string;
      planServices?: PlanServiceNode[];
    },
  ): Promise<WorkflowRecord> {
    const workflow = await this.requireWorkflow(workflowId);

    if (workflow.status === 'WAITING_SPEC_APPROVAL' || workflow.status === 'CODING') {
      // Spec revision changed after approval path — invalidate and re-enter waiting.
      if (workflow.specHash && workflow.specHash !== input.specHash) {
        const expectedVersion = workflow.version;
        const now = this.now().toISOString();
        for (const approval of workflow.approvals) {
          if (!approval.invalidatedAt) {
            approval.invalidatedAt = now;
          }
        }
        workflow.specHash = input.specHash;
        workflow.implementationSpecUri = input.implementationSpecUri;
        workflow.planServices = input.planServices;
        workflow.status = 'WAITING_SPEC_APPROVAL';
        workflow.version += 1;
        workflow.updatedAt = now;
        workflow.timeline.push({
          at: now,
          type: 'SPEC_HASH_CHANGED_APPROVAL_INVALIDATED',
          detail: input.specHash,
        });
        await this.deps.repository.updateConditional(workflow, expectedVersion);
        this.deps.onApprovalsInvalidated?.(workflowId);
        return workflow;
      }
    }

    assertTransition(workflow.status, 'WAITING_SPEC_APPROVAL');

    const expectedVersion = workflow.version;
    workflow.status = 'WAITING_SPEC_APPROVAL';
    workflow.specHash = input.specHash;
    workflow.implementationSpecUri = input.implementationSpecUri;
    workflow.planServices = input.planServices;
    workflow.version += 1;
    workflow.updatedAt = this.now().toISOString();
    workflow.desiredJobs = workflow.desiredJobs.map((job) =>
      job.stage === 'planner' ? { ...job, status: 'SUCCEEDED' } : job,
    );
    workflow.timeline.push({
      at: workflow.updatedAt,
      type: 'WAITING_SPEC_APPROVAL',
      detail: input.specHash,
    });
    await this.deps.repository.updateConditional(workflow, expectedVersion);
    return workflow;
  }

  /**
   * HITL gate: bind decision to exact current specHash + expectedVersion.
   */
  async approveSpec(input: ApproveSpecInput): Promise<WorkflowRecord> {
    const identity: ApproverIdentity = input.approver;
    if (!this.approverPolicy.isAuthorized(identity)) {
      throw new ApprovalError('Approver not authorized', 403);
    }

    const workflow = await this.requireWorkflow(input.workflowId);
    if (workflow.status !== 'WAITING_SPEC_APPROVAL') {
      throw new ApprovalError(
        `Workflow not waiting for approval (status=${workflow.status})`,
        409,
      );
    }
    if (!workflow.specHash) {
      throw new ApprovalError('Workflow has no specHash', 409);
    }
    if (input.approvedSpecHash !== workflow.specHash) {
      throw new ApprovalError(
        'approvedSpecHash does not match current immutable spec hash',
        409,
      );
    }
    if (input.approvedSddCommitSha !== workflow.sddCommitSha) {
      throw new ApprovalError(
        'approvedSddCommitSha does not match pinned SDD commit SHA',
        409,
      );
    }
    if (input.expectedVersion !== workflow.version) {
      throw new ApprovalError(
        `expectedVersion mismatch: got ${input.expectedVersion}, current ${workflow.version}`,
        409,
      );
    }

    const expectedVersion = workflow.version;
    const now = this.now().toISOString();
    const decisionId = `APR#${input.workflowId}#${now}`;

    workflow.approvals.push({
      decisionId,
      decision: input.decision,
      approvedSpecHash: input.approvedSpecHash,
      approvedSddCommitSha: input.approvedSddCommitSha,
      approverEntraId: identity.entraId,
      approverDisplayName: identity.displayName,
      expectedVersion: input.expectedVersion,
      comment: input.comment,
      decidedAt: now,
    });

    if (input.decision === 'APPROVED') {
      assertTransition(workflow.status, 'CODING');
      workflow.status = 'CODING';
      const plan =
        workflow.planServices ??
        workflow.targets.map((target, index, all) => ({
          repository: target.repository,
          workingBranch: target.workingBranch,
          targetBranch: target.targetBranch,
          dependsOn: index === 0 ? [] : [all[index - 1]!.repository],
        }));
      workflow.planServices = plan;
      for (const service of plan) {
        workflow.services[service.repository] = {
          repository: service.repository,
          workingBranch: service.workingBranch,
          targetBranch: service.targetBranch,
          dependsOn: service.dependsOn,
          state: service.dependsOn.length === 0 ? 'CODING' : 'PENDING',
          fixAttempts: 0,
        };
      }
      workflow.timeline.push({
        at: now,
        type: 'SPEC_APPROVED',
        detail: `${identity.entraId}; ${input.approvedSpecHash}`,
      });
    } else if (input.decision === 'SPEC_CHANGES_REQUESTED') {
      assertTransition(workflow.status, 'SPEC_CHANGES_REQUESTED');
      workflow.status = 'SPEC_CHANGES_REQUESTED';
      workflow.timeline.push({
        at: now,
        type: 'SPEC_CHANGES_REQUESTED',
        detail: identity.entraId,
      });
    } else {
      assertTransition(workflow.status, 'CANCELLED');
      workflow.status = 'CANCELLED';
      workflow.timeline.push({
        at: now,
        type: 'SPEC_REJECTED',
        detail: identity.entraId,
      });
    }

    workflow.version += 1;
    workflow.updatedAt = now;

    try {
      await this.deps.repository.updateConditional(workflow, expectedVersion);
    } catch (error) {
      if (error instanceof ConditionalWriteError) {
        throw new ApprovalError(
          'Concurrent approval conflict — refresh and retry',
          409,
        );
      }
      throw error;
    }

    return workflow;
  }

  hasValidApproval(workflow: WorkflowRecord): boolean {
    if (!workflow.specHash) return false;
    return workflow.approvals.some(
      (a) =>
        a.decision === 'APPROVED' &&
        a.approvedSpecHash === workflow.specHash &&
        a.approvedSddCommitSha === workflow.sddCommitSha &&
        !a.invalidatedAt,
    );
  }

  async markNeedsSpecClarification(
    workflowId: string,
    issues: Array<{ code: string; message: string; path?: string }>,
  ): Promise<WorkflowRecord> {
    const workflow = await this.requireWorkflow(workflowId);
    assertTransition(workflow.status, 'NEEDS_SPEC_CLARIFICATION');
    const expectedVersion = workflow.version;
    workflow.status = 'NEEDS_SPEC_CLARIFICATION';
    workflow.clarificationIssues = issues;
    workflow.version += 1;
    workflow.updatedAt = this.now().toISOString();
    workflow.timeline.push({
      at: workflow.updatedAt,
      type: 'NEEDS_SPEC_CLARIFICATION',
      detail: issues.map((i) => i.code).join(','),
    });
    await this.deps.repository.updateConditional(workflow, expectedVersion);
    return workflow;
  }

  async recordCodingResult(
    workflowId: string,
    input: {
      repository: string;
      commitSha: string;
      mrIid: number;
      jobId: string;
    },
  ): Promise<{ workflow: WorkflowRecord; newlyUnlocked: string[] }> {
    const workflow = await this.requireWorkflow(workflowId);
    if (!this.hasValidApproval(workflow)) {
      throw new ApprovalError('Coding result rejected: no valid approval', 409);
    }
    const service = workflow.services[input.repository];
    if (!service) {
      throw new ApprovalError(`Unknown service: ${input.repository}`, 404);
    }

    const expectedVersion = workflow.version;
    const now = this.now().toISOString();
    service.state = 'AWAITING_CI';
    service.expectedCommitSha = input.commitSha;
    service.mrIid = input.mrIid;

    workflow.desiredJobs.push({
      jobId: input.jobId,
      stage: 'coding',
      status: 'SUCCEEDED',
      repository: input.repository,
      createdAt: now,
      k8sJobName: `hl-coding-${input.repository}`.slice(0, 63),
    });

    // M4: unlock dependents after upstream coding+MR exists (CI still pending).
    // M5 can tighten this to READY-only after green CI if product requires it.
    const newlyUnlocked: string[] = [];
    for (const candidate of Object.values(workflow.services)) {
      if (candidate.state !== 'PENDING') continue;
      const depsCoded = candidate.dependsOn.every((dep) => {
        const state = workflow.services[dep]?.state;
        return state === 'AWAITING_CI' || state === 'READY';
      });
      if (depsCoded) {
        candidate.state = 'CODING';
        newlyUnlocked.push(candidate.repository);
      }
    }

    workflow.version += 1;
    workflow.updatedAt = now;
    workflow.timeline.push({
      at: now,
      type: 'CODING_MR_READY',
      detail: `${input.repository}@${input.commitSha}; mr=${input.mrIid}`,
    });
    await this.deps.repository.updateConditional(workflow, expectedVersion);
    return { workflow, newlyUnlocked };
  }

  async getWorkflow(workflowId: string): Promise<WorkflowRecord | null> {
    return this.deps.repository.getById(workflowId);
  }

  async cancel(workflowId: string): Promise<WorkflowRecord> {
    const workflow = await this.requireWorkflow(workflowId);
    assertTransition(workflow.status, 'CANCELLED');
    const expectedVersion = workflow.version;
    const at = this.now().toISOString();
    workflow.status = 'CANCELLED';
    workflow.executions = (workflow.executions ?? []).map((lease) =>
      lease.fencedAt ? lease : { ...lease, fencedAt: at },
    );
    workflow.version += 1;
    workflow.updatedAt = at;
    workflow.timeline.push({ at, type: 'CANCELLED' });
    if ((workflow.executions ?? []).some((e) => e.fencedAt === at)) {
      workflow.timeline.push({ at, type: 'EXECUTIONS_FENCED', detail: 'workflow cancelled' });
    }
    await this.deps.repository.updateConditional(workflow, expectedVersion);
    return workflow;
  }

  async resume(workflowId: string): Promise<WorkflowRecord> {
    const workflow = await this.requireWorkflow(workflowId);
    if (workflow.status !== 'NEEDS_HUMAN' && workflow.status !== 'SPEC_CHANGES_REQUESTED') {
      throw new Error(`Cannot resume workflow in status ${workflow.status}`);
    }
    const next = workflow.status === 'SPEC_CHANGES_REQUESTED' ? 'PLANNING' : 'CODING';
    assertTransition(workflow.status, next);
    const expectedVersion = workflow.version;
    workflow.status = next;
    workflow.version += 1;
    workflow.updatedAt = this.now().toISOString();
    workflow.timeline.push({ at: workflow.updatedAt, type: 'RESUMED', detail: next });
    await this.deps.repository.updateConditional(workflow, expectedVersion);
    return workflow;
  }

  private async requireWorkflow(workflowId: string): Promise<WorkflowRecord> {
    const workflow = await this.deps.repository.getById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    return workflow;
  }
}
