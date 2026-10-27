import type { ExecutionLease, WorkflowRecord } from '../../domain/types.js';
import {
  ConditionalWriteError,
  type WorkflowRepository,
} from './workflow-repository.js';

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly events = new Map<string, string>();
  private readonly executionIndex = new Map<string, string>();

  async getById(workflowId: string): Promise<WorkflowRecord | null> {
    const current = this.workflows.get(workflowId);
    return current ? structuredClone(current) : null;
  }

  async createIfAbsent(workflow: WorkflowRecord): Promise<'created' | 'exists'> {
    if (this.workflows.has(workflow.workflowId)) {
      return 'exists';
    }
    this.workflows.set(workflow.workflowId, structuredClone(workflow));
    this.indexExecutions(workflow);
    return 'created';
  }

  async updateConditional(
    workflow: WorkflowRecord,
    expectedVersion: number,
  ): Promise<void> {
    const current = this.workflows.get(workflow.workflowId);
    if (!current) {
      throw new ConditionalWriteError(`Workflow not found: ${workflow.workflowId}`);
    }
    if (current.version !== expectedVersion) {
      throw new ConditionalWriteError(
        `Version conflict for ${workflow.workflowId}: expected ${expectedVersion}, got ${current.version}`,
      );
    }
    this.workflows.set(workflow.workflowId, structuredClone(workflow));
    this.indexExecutions(workflow);
  }

  async findByExecutionId(
    executionId: string,
  ): Promise<{ workflow: WorkflowRecord; lease: ExecutionLease } | null> {
    const workflowId = this.executionIndex.get(executionId);
    if (!workflowId) return null;
    const workflow = await this.getById(workflowId);
    if (!workflow) return null;
    const lease = workflow.executions?.find((e) => e.executionId === executionId);
    if (!lease) return null;
    return { workflow, lease };
  }

  private indexExecutions(workflow: WorkflowRecord): void {
    for (const lease of workflow.executions ?? []) {
      this.executionIndex.set(lease.executionId, workflow.workflowId);
    }
  }

  async recordEventOnce(
    eventId: string,
    workflowId: string,
  ): Promise<'recorded' | 'duplicate'> {
    if (this.events.has(eventId)) {
      return 'duplicate';
    }
    this.events.set(eventId, workflowId);
    return 'recorded';
  }

  async listTimeline(workflowId: string): Promise<WorkflowRecord['timeline']> {
    const workflow = this.workflows.get(workflowId);
    return workflow ? structuredClone(workflow.timeline) : [];
  }
}
