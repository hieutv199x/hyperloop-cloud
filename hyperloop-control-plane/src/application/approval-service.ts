import type { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import type { ApproveSpecInput, WorkflowRecord } from '../domain/types.js';
import { ApprovalError, WorkflowOrchestrator } from './workflow-orchestrator.js';

/**
 * Coordinates HITL approval with scheduler unlock of coding DAG roots.
 */
export class ApprovalService {
  constructor(
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly scheduler: JobQueueScheduler,
  ) {}

  async approve(input: ApproveSpecInput): Promise<{
    workflow: WorkflowRecord;
    codingTasksEnqueued: string[];
  }> {
    const workflow = await this.orchestrator.approveSpec(input);
    const codingTasksEnqueued: string[] = [];

    if (input.decision !== 'APPROVED' || !workflow.specHash) {
      return { workflow, codingTasksEnqueued };
    }

    this.scheduler.store.markSpecApproved(workflow.workflowId, workflow.specHash);

    const services =
      workflow.planServices ??
      workflow.targets.map((target, index, all) => ({
        repository: target.repository,
        workingBranch: target.workingBranch,
        targetBranch: target.targetBranch,
        dependsOn: index === 0 ? [] : [all[index - 1]!.repository],
      }));

    // Only enqueue DAG roots (no unmet dependsOn). Dependent repos wait for M4 completion hooks.
    const roots = services.filter((s) => s.dependsOn.length === 0);
    for (const service of roots) {
      const taskId = `${workflow.workflowId}:coding:${service.repository}:1`;
      await this.scheduler.enqueue({
        taskId,
        workflowId: workflow.workflowId,
        stage: 'coding',
        repository: service.repository,
        project: workflow.project,
        approvedSpecHash: workflow.specHash,
        dependsOn: [],
        attempt: 1,
      });
      codingTasksEnqueued.push(taskId);
    }

    return { workflow, codingTasksEnqueued };
  }

  async assertCodingAllowed(workflowId: string): Promise<void> {
    const workflow = await this.orchestrator.getWorkflow(workflowId);
    if (!workflow) {
      throw new ApprovalError('Workflow not found', 404);
    }
    if (!this.orchestrator.hasValidApproval(workflow)) {
      throw new ApprovalError('Coding blocked: no valid approval for current specHash', 409);
    }
  }
}
