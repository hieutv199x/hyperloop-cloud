import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { InMemoryArtifactStore } from '../adapters/s3/artifact-store.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';
import { PlannerVerticalSlice } from './planner-vertical-slice.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

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

describe('M2 planner vertical slice', () => {
  it('submit → planner job → Implementation Spec on S3 → WAITING_SPEC_APPROVAL', async () => {
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
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
    });

    const slice = new PlannerVerticalSlice({
      orchestrator,
      scheduler,
      kubernetes,
      artifacts,
      artifactsBucket: 'hyperloop-artifacts',
      agentNamespace: 'hyperloop-agents',
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
    });

    const workflow = await slice.run({
      eventId: 'evt-m2-1',
      project: 'transaction-banking',
      userStory: 'PAY-1234',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
      devSpec,
    });

    expect(workflow.status).toBe('WAITING_SPEC_APPROVAL');
    expect(workflow.specHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(workflow.implementationSpecUri).toMatch(/^s3:\/\//);
    expect(artifacts.objects.has(workflow.implementationSpecUri!)).toBe(true);

    const plan = JSON.parse(artifacts.objects.get(workflow.implementationSpecUri!)!) as {
      kind: string;
      spec: { dag: { nodes: string[] } };
      metadata: { specHash: string };
    };
    expect(plan.kind).toBe('ImplementationSpec');
    expect(plan.metadata.specHash).toBe(workflow.specHash);
    expect(plan.spec.dag.nodes).toEqual([
      'coc-ewallet-service',
      'access-control-adapter',
    ]);

    // Planner Job was created and reached terminal success; slot released.
    expect(kubernetes.createCalls.length).toBeGreaterThanOrEqual(1);
    expect(scheduler.store.capacity.getState().used).toBe(0);
    expect(
      workflow.desiredJobs.find((j) => j.stage === 'planner')?.status,
    ).toBe('SUCCEEDED');
  });
});
