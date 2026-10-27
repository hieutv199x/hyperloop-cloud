import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../../hyperloop-control-plane/src/adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../../hyperloop-control-plane/src/adapters/kubernetes/fake-kubernetes.js';
import { InMemoryArtifactStore } from '../../hyperloop-control-plane/src/adapters/s3/artifact-store.js';
import {
  AgentResultIngestor,
} from '../../hyperloop-control-plane/src/application/agent-result-ingestor.js';
import { WorkflowOrchestrator } from '../../hyperloop-control-plane/src/application/workflow-orchestrator.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../../hyperloop-control-plane/src/scheduler/config.js';
import { JobQueueScheduler } from '../../hyperloop-control-plane/src/scheduler/job-queue-scheduler.js';
import { InMemoryQueueBus } from '../../hyperloop-control-plane/src/workers/in-memory-queue.js';
import { simulatePlannerJob } from '../src/agent-job-simulator.js';

const devSpec = {
  apiVersion: 'hyperloop.dev/v1',
  kind: 'DevelopmentSpec',
  metadata: {
    project: 'transaction-banking',
    userStory: 'PAY-1234',
    revision: 1,
  },
  spec: {
    status: 'submitted',
    requirements: ['02-requirements/PAY-1234/US.md'],
    designs: ['03-designs/PAY-1234/solution-design.md'],
    acceptanceCriteria: ['04-development/PAY-1234/acceptance-criteria.md'],
    targets: [
      {
        repository: 'coc-ewallet-service',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
      },
      {
        repository: 'access-control-adapter',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
      },
    ],
    execution: {
      requireSpecApproval: true,
      maxAutoFixAttempts: 2,
    },
  },
};

describe('e2e M2 planner (agent outside Control Plane)', () => {
  it('submit → planner Job → ingest result → WAITING_SPEC_APPROVAL', async () => {
    const repository = new InMemoryWorkflowRepository();
    const kubernetes = new FakeKubernetesAdapter();
    const artifacts = new InMemoryArtifactStore();
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, kubernetes, {
      queueBus: new InMemoryQueueBus(),
    });
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes,
      agentNamespace: 'hyperloop-agents',
      agentImages: DEFAULT_SCHEDULER_CONFIG.kubernetes.images,
    });
    const ingestor = new AgentResultIngestor(orchestrator, artifacts);

    const submitted = await orchestrator.submitDevSpec({
      eventId: 'evt-m2-1',
      occurredAt: new Date().toISOString(),
      project: 'transaction-banking',
      userStory: 'PAY-1234',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
      devSpec,
    });
    expect(submitted.outcome).toBe('created');
    if (submitted.outcome !== 'created') return;

    const plannerIntent = submitted.workflow.desiredJobs.find((j) => j.stage === 'planner');
    expect(plannerIntent).toBeTruthy();

    await scheduler.enqueue({
      taskId: plannerIntent!.jobId,
      workflowId: submitted.workflow.workflowId,
      stage: 'planner',
      project: submitted.workflow.project,
      attempt: 1,
    });
    await scheduler.dispatchOnce();
    await scheduler.reconciler.reconcileReserved();

    const task = scheduler.store.getTask(plannerIntent!.jobId);
    expect(task?.k8sJobName).toBeTruthy();

    const resultUri = await simulatePlannerJob({
      jobId: plannerIntent!.jobId,
      workflowId: submitted.workflow.workflowId,
      sddCommitSha: submitted.workflow.sddCommitSha,
      artifactsBucket: 'hyperloop-artifacts',
      artifacts,
      kubernetes,
      namespace: 'hyperloop-agents',
      k8sJobName: task!.k8sJobName!,
      devSpec,
    });

    await scheduler.finalizeFromKubernetes(plannerIntent!.jobId);
    const workflow = await ingestor.ingestPlanner({
      workflowId: submitted.workflow.workflowId,
      resultUri,
    });

    expect(workflow.status).toBe('WAITING_SPEC_APPROVAL');
    expect(workflow.specHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(workflow.implementationSpecUri).toMatch(/^s3:\/\//);
    expect(artifacts.objects.has(workflow.implementationSpecUri!)).toBe(true);
    expect(scheduler.store.capacity.getState().used).toBe(0);
  });
});
