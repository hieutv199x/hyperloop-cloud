import { createHash, randomBytes } from 'node:crypto';
import type { WorkflowRepository } from '../adapters/dynamodb/workflow-repository.js';
import type { ExecutionLease, WorkflowRecord } from '../domain/types.js';

export class FenceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FenceError';
  }
}

export type AuthorizePushResult =
  | { ok: true; executionId: string; workflowId: string }
  | { ok: false; statusCode: number; reason: string };

/**
 * Issues and validates per-execution fence tokens.
 * Leases are persisted on the WorkflowRecord (not an in-memory Set).
 */
export class ExecutionFenceService {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    workflowId: string;
    jobId: string;
    role: ExecutionLease['role'];
    repository?: string;
    leaseTtlSeconds?: number;
  }): Promise<ExecutionLease> {
    const workflow = await this.requireWorkflow(input.workflowId);
    const expectedVersion = workflow.version;
    const issuedAt = this.now().toISOString();
    const leaseExpiresAt = new Date(
      this.now().getTime() + (input.leaseTtlSeconds ?? 3600) * 1000,
    ).toISOString();
    const executionId = `exec:${input.jobId}`;
    const fenceToken = createHash('sha256')
      .update(`${executionId}:${randomBytes(16).toString('hex')}`)
      .digest('hex')
      .slice(0, 32);

    const lease: ExecutionLease = {
      executionId,
      jobId: input.jobId,
      role: input.role,
      fenceToken,
      leaseExpiresAt,
      issuedAt,
      repository: input.repository,
    };

    workflow.executions = [
      ...(workflow.executions ?? []).filter((e) => e.executionId !== executionId),
      lease,
    ];
    workflow.version += 1;
    workflow.updatedAt = issuedAt;
    workflow.timeline.push({
      at: issuedAt,
      type: 'EXECUTION_LEASE_ISSUED',
      detail: `${executionId};role=${input.role}`,
    });
    await this.repository.updateConditional(workflow, expectedVersion);
    return lease;
  }

  async authorizePush(input: {
    executionId: string;
    fenceToken: string;
  }): Promise<AuthorizePushResult> {
    const found = await this.findLease(input.executionId);
    if (!found) {
      return { ok: false, statusCode: 404, reason: 'Unknown executionId' };
    }
    const { workflow, lease } = found;
    if (lease.fenceToken !== input.fenceToken) {
      return { ok: false, statusCode: 409, reason: 'fenceToken mismatch' };
    }
    if (lease.fencedAt) {
      return {
        ok: false,
        statusCode: 409,
        reason: `Execution fenced at ${lease.fencedAt}; further push denied`,
      };
    }
    if (Date.parse(lease.leaseExpiresAt) <= this.now().getTime()) {
      return { ok: false, statusCode: 409, reason: 'Execution lease expired' };
    }
    return { ok: true, executionId: lease.executionId, workflowId: workflow.workflowId };
  }

  async fenceWorkflow(workflowId: string, reason: string): Promise<WorkflowRecord> {
    const workflow = await this.requireWorkflow(workflowId);
    const expectedVersion = workflow.version;
    const at = this.now().toISOString();
    workflow.executions = (workflow.executions ?? []).map((lease) =>
      lease.fencedAt ? lease : { ...lease, fencedAt: at },
    );
    workflow.version += 1;
    workflow.updatedAt = at;
    workflow.timeline.push({
      at,
      type: 'EXECUTIONS_FENCED',
      detail: reason,
    });
    await this.repository.updateConditional(workflow, expectedVersion);
    return workflow;
  }

  async fenceExecution(executionId: string, reason: string): Promise<ExecutionLease> {
    const found = await this.findLease(executionId);
    if (!found) {
      throw new FenceError(`Unknown executionId: ${executionId}`, 404);
    }
    const { workflow, lease } = found;
    if (lease.fencedAt) return lease;
    const expectedVersion = workflow.version;
    const at = this.now().toISOString();
    lease.fencedAt = at;
    workflow.version += 1;
    workflow.updatedAt = at;
    workflow.timeline.push({
      at,
      type: 'EXECUTION_FENCED',
      detail: `${executionId};${reason}`,
    });
    await this.repository.updateConditional(workflow, expectedVersion);
    return lease;
  }

  private async findLease(
    executionId: string,
  ): Promise<{ workflow: WorkflowRecord; lease: ExecutionLease } | null> {
    if (!this.repository.findByExecutionId) {
      throw new FenceError('Workflow repository lacks execution index', 500);
    }
    return this.repository.findByExecutionId(executionId);
  }

  private async requireWorkflow(workflowId: string): Promise<WorkflowRecord> {
    const workflow = await this.repository.getById(workflowId);
    if (!workflow) {
      throw new FenceError(`Workflow not found: ${workflowId}`, 404);
    }
    return workflow;
  }
}
