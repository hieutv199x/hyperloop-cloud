import {
  InMemoryArtifactStore as AgentArtifactStore,
  runCoding,
} from '@hyperloop/agent-runtime';
import type { GitLabPort } from '@hyperloop/integrations';
import type { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { buildAgentJobSpec } from '../adapters/kubernetes/job-builder.js';
import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import type { ArtifactStore } from '../adapters/s3/artifact-store.js';
import type { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import type { WorkflowRecord } from '../domain/types.js';
import type { SddRevisionManager } from '../sdd/sdd-revision-manager.js';
import { ApprovalService } from './approval-service.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

export interface CodingSliceDeps {
  orchestrator: WorkflowOrchestrator;
  approvals: ApprovalService;
  scheduler: JobQueueScheduler;
  kubernetes: KubernetesJobPort;
  artifacts: ArtifactStore;
  artifactsBucket: string;
  agentNamespace: string;
  agentImage: string;
  gitlab: GitLabPort;
  /** v1.2: optional fence registry; fenced workflows cannot push. */
  revisions?: SddRevisionManager;
}

/**
 * M4 vertical slice for one coding task:
 * dispatch Job → run coding agent → MR to release branch → record AWAITING_CI
 * → enqueue newly unlocked dependent coding tasks.
 */
export class CodingVerticalSlice {
  constructor(private readonly deps: CodingSliceDeps) {}

  async runTask(taskId: string): Promise<{
    workflow: WorkflowRecord;
    commitSha: string;
    mrIid: number;
    newlyUnlocked: string[];
  }> {
    const task = this.deps.scheduler.store.getTask(taskId);
    if (!task || task.stage !== 'coding' || !task.repository) {
      throw new Error(`Coding task not found: ${taskId}`);
    }

    await this.deps.approvals.assertCodingAllowed(task.workflowId);
    const workflow = await this.deps.orchestrator.getWorkflow(task.workflowId);
    if (!workflow?.specHash) {
      throw new Error('Workflow missing approved specHash');
    }
    const service = workflow.services[task.repository];
    if (!service) {
      throw new Error(`Service not initialized: ${task.repository}`);
    }

    await this.deps.scheduler.dispatchOnce();
    await this.deps.scheduler.reconciler.reconcileReserved();

    const scheduled = this.deps.scheduler.store.getTask(taskId);
    if (!scheduled?.k8sJobName) {
      // Task may still be queued if capacity full; force reserve path for slice tests.
      const reservation = await this.deps.scheduler.reservations.reserveWithBackoff(taskId);
      if (!reservation) {
        throw new Error(`Unable to reserve coding task ${taskId}`);
      }
      await this.deps.scheduler.dispatcher.dispatch(scheduled ?? task, reservation);
      await this.deps.scheduler.store.markScheduled(taskId);
    }

    const current = this.deps.scheduler.store.getTask(taskId)!;
    await this.deps.kubernetes.createJob(
      buildAgentJobSpec({
        name: current.k8sJobName!,
        namespace: this.deps.agentNamespace,
        image: this.deps.agentImage,
        workflowId: workflow.workflowId,
        jobId: taskId,
        stage: 'coding',
      }),
    );

    const agentStore = new AgentArtifactStore();
    const result = await runCoding({
      stage: 'coding',
      jobId: taskId,
      workflowId: workflow.workflowId,
      repository: service.repository,
      workingBranch: service.workingBranch,
      targetBranch: service.targetBranch,
      approvedSpecHash: workflow.specHash,
      expectedApprovedSpecHash: workflow.specHash,
      artifactsBucket: this.deps.artifactsBucket,
      artifactStore: agentStore,
      gitlab: this.deps.gitlab,
      assertPushAllowed: () => {
        this.deps.revisions?.assertNotFenced(workflow.workflowId);
      },
    });

    for (const [uri, body] of agentStore.objects.entries()) {
      await this.deps.artifacts.putObject(uri, body);
    }

    const fake = this.deps.kubernetes as FakeKubernetesAdapter;
    if (result.exitStatus !== 'SUCCEEDED' || !result.commitSha || !result.mrIid) {
      fake.setPhase?.(this.deps.agentNamespace, current.k8sJobName!, 'Failed');
      throw new Error(result.message);
    }

    fake.setPhase?.(this.deps.agentNamespace, current.k8sJobName!, 'Succeeded');
    await this.deps.scheduler.finalizeFromKubernetes(taskId);

    const recorded = await this.deps.orchestrator.recordCodingResult(workflow.workflowId, {
      repository: service.repository,
      commitSha: result.commitSha,
      mrIid: result.mrIid,
      jobId: taskId,
    });

    for (const repo of recorded.newlyUnlocked) {
      const unlocked = recorded.workflow.services[repo]!;
      await this.deps.scheduler.enqueue({
        taskId: `${workflow.workflowId}:coding:${repo}:1`,
        workflowId: workflow.workflowId,
        stage: 'coding',
        repository: repo,
        project: workflow.project,
        approvedSpecHash: workflow.specHash,
        attempt: 1,
      });
      void unlocked;
    }

    return {
      workflow: recorded.workflow,
      commitSha: result.commitSha,
      mrIid: result.mrIid,
      newlyUnlocked: recorded.newlyUnlocked,
    };
  }
}
