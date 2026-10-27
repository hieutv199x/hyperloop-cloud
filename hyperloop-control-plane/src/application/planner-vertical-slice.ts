import {
  InMemoryArtifactStore as AgentArtifactStore,
  runPlanner,
} from '@hyperloop/agent-runtime';
import type { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { buildAgentJobSpec } from '../adapters/kubernetes/job-builder.js';
import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import type { ArtifactStore } from '../adapters/s3/artifact-store.js';
import type { DevSpecDocument, WorkflowRecord } from '../domain/types.js';
import type { PlanningCoordinator } from '../planning/planning-coordinator.js';
import type { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

export interface PlannerSliceDeps {
  orchestrator: WorkflowOrchestrator;
  scheduler: JobQueueScheduler;
  kubernetes: KubernetesJobPort;
  artifacts: ArtifactStore;
  artifactsBucket: string;
  agentNamespace: string;
  agentImage: string;
  /** v1.2: when set, run SDD completeness gate before scheduling Planner. */
  planning?: PlanningCoordinator;
}

/**
 * M2 / v1.2 vertical slice runner:
 * SDD gate → submit → enqueue planner → in-process planner → WAITING_SPEC_APPROVAL.
 * Incomplete SDD yields NEEDS_SPEC_CLARIFICATION with zero Planner Jobs.
 */
export class PlannerVerticalSlice {
  constructor(private readonly deps: PlannerSliceDeps) {}

  async run(input: {
    eventId: string;
    project: string;
    userStory: string;
    revision: number;
    sddCommitSha: string;
    sddPath: string;
    devSpec: DevSpecDocument;
    webhookSecret?: string;
    sddProject?: string;
    changedPaths?: string[];
  }): Promise<WorkflowRecord> {
    let clarificationIssues:
      | Array<{ code: string; message: string; path?: string }>
      | undefined;

    if (this.deps.planning) {
      const intake = await this.deps.planning.intake({
        eventId: input.eventId,
        sddProject: input.sddProject ?? input.project,
        sddCommitSha: input.sddCommitSha,
        devSpecId: input.userStory,
        changedPaths: input.changedPaths ?? [input.sddPath],
      });

      if (intake.outcome === 'ignore' || intake.outcome === 'duplicate') {
        throw new Error(`SDD intake ${intake.outcome}: ${intake.reason}`);
      }
      if (intake.outcome === 'needs_clarification') {
        clarificationIssues = intake.issues;
      }
    }

    const submitted = await this.deps.orchestrator.submitDevSpec({
      ...input,
      sddProject: input.sddProject ?? input.project,
      clarificationIssues,
      occurredAt: new Date().toISOString(),
    });
    if (submitted.outcome === 'rejected') {
      throw new Error(submitted.reason);
    }

    const workflow = submitted.workflow;
    if (workflow.status === 'NEEDS_SPEC_CLARIFICATION') {
      return workflow;
    }

    const plannerIntent = workflow.desiredJobs.find((j) => j.stage === 'planner');
    if (!plannerIntent) {
      throw new Error('Planner JOB_DESIRED missing');
    }

    await this.deps.scheduler.enqueue({
      taskId: plannerIntent.jobId,
      workflowId: workflow.workflowId,
      stage: 'planner',
      project: workflow.project,
      attempt: 1,
    });

    await this.deps.scheduler.dispatchOnce();
    await this.deps.scheduler.reconciler.reconcileReserved();

    const task = this.deps.scheduler.store.getTask(plannerIntent.jobId);
    if (!task?.k8sJobName) {
      throw new Error('Planner task was not reserved/scheduled');
    }

    await this.deps.kubernetes.createJob(
      buildAgentJobSpec({
        name: task.k8sJobName,
        namespace: this.deps.agentNamespace,
        image: this.deps.agentImage,
        workflowId: workflow.workflowId,
        jobId: plannerIntent.jobId,
        stage: 'planner',
        sddCommitSha: workflow.sddCommitSha,
      }),
    );

    const agentStore = new AgentArtifactStore();
    const plannerResult = await runPlanner({
      stage: 'planner',
      jobId: plannerIntent.jobId,
      workflowId: workflow.workflowId,
      sddCommitSha: workflow.sddCommitSha,
      artifactsBucket: this.deps.artifactsBucket,
      artifactStore: agentStore,
      devSpec: {
        metadata: input.devSpec.metadata,
        spec: {
          requirements: input.devSpec.spec.requirements,
          analysis: input.devSpec.spec.analysis,
          designs: input.devSpec.spec.designs,
          acceptanceCriteria: input.devSpec.spec.acceptanceCriteria,
          targets: input.devSpec.spec.targets,
        },
      },
    });

    for (const [uri, body] of agentStore.objects.entries()) {
      await this.deps.artifacts.putObject(uri, body);
    }

    if (plannerResult.exitStatus !== 'SUCCEEDED' || !plannerResult.specHash) {
      const fake = this.deps.kubernetes as FakeKubernetesAdapter;
      fake.setPhase?.(this.deps.agentNamespace, task.k8sJobName, 'Failed');
      throw new Error(plannerResult.message);
    }

    const fake = this.deps.kubernetes as FakeKubernetesAdapter;
    if (typeof fake.setPhase === 'function') {
      fake.setPhase(this.deps.agentNamespace, task.k8sJobName, 'Succeeded');
    }

    await this.deps.scheduler.finalizeFromKubernetes(plannerIntent.jobId);

    return this.deps.orchestrator.completePlanner(workflow.workflowId, {
      specHash: plannerResult.specHash,
      implementationSpecUri: plannerResult.implementationSpecUri!,
      planServices: plannerResult.planServices,
    });
  }
}
