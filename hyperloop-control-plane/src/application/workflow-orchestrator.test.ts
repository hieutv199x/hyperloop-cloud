import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import type { DevSpecDocument } from '../domain/types.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

const sampleDevSpec: DevSpecDocument = {
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
    ],
    execution: {
      requireSpecApproval: true,
      maxAutoFixAttempts: 2,
    },
  },
};

function createOrchestrator(secret?: string) {
  const repository = new InMemoryWorkflowRepository();
  const kubernetes = new FakeKubernetesAdapter();
  const orchestrator = new WorkflowOrchestrator({
    repository,
    kubernetes,
    agentNamespace: 'hyperloop-agents',
    agentImages: {
      planner: 'nexus.example/hyperloop/kiro-agent-planner:0.1.0',
      coding: 'nexus.example/hyperloop/kiro-agent-coding:0.1.0',
      fix: 'nexus.example/hyperloop/kiro-agent-fix:0.1.0',
    },
    webhookSecret: secret,
  });
  return { orchestrator, repository, kubernetes };
}

describe('WorkflowOrchestrator M1', () => {
  it('creates workflow, persists planner JOB_DESIRED, transitions to PLANNING', async () => {
    const { orchestrator, kubernetes } = createOrchestrator('secret');
    const result = await orchestrator.submitDevSpec({
      eventId: 'evt-1',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-1234',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
      devSpec: sampleDevSpec,
      webhookSecret: 'secret',
    });

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;

    expect(result.workflow.status).toBe('PLANNING');
    expect(result.workflow.desiredJobs).toHaveLength(1);
    expect(result.workflow.desiredJobs[0]?.status).toBe('JOB_DESIRED');
    expect(result.workflow.desiredJobs[0]?.stage).toBe('planner');

    const job = await kubernetes.getJob(
      'hyperloop-agents',
      result.workflow.desiredJobs[0]!.k8sJobName,
    );
    expect(job.phase).toBe('Pending');
  });

  it('dedupes duplicate eventId without creating a second workflow', async () => {
    const { orchestrator, repository } = createOrchestrator('secret');
    const payload = {
      eventId: 'evt-dup',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-1234',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
      devSpec: sampleDevSpec,
      webhookSecret: 'secret',
    };

    const first = await orchestrator.submitDevSpec(payload);
    const second = await orchestrator.submitDevSpec(payload);

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('duplicate');

    const stored = await repository.getById('WF#PAY-1234#1');
    expect(stored?.version).toBe(2);
    expect(stored?.status).toBe('PLANNING');
  });

  it('v1.2 incomplete SDD → NEEDS_SPEC_CLARIFICATION without Planner Job', async () => {
    const { orchestrator, kubernetes } = createOrchestrator();
    const result = await orchestrator.submitDevSpec({
      eventId: 'evt-clarify',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'payment-sdd',
      userStory: 'PAY-5555',
      revision: 1,
      sddCommitSha: 'dddddddddddddddddddddddddddddddddddddddd',
      sddPath: '04-development/PAY-5555/dev-spec.yaml',
      sddProject: 'payment-sdd',
      clarificationIssues: [
        { code: 'HL_SDD_MISSING_DOCUMENT', message: 'Missing design', path: '03-design/x.md' },
      ],
      devSpec: {
        ...sampleDevSpec,
        metadata: { ...sampleDevSpec.metadata, project: 'payment-sdd', userStory: 'PAY-5555' },
      },
    });

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    expect(result.workflow.status).toBe('NEEDS_SPEC_CLARIFICATION');
    expect(result.workflow.desiredJobs).toHaveLength(0);
    expect(kubernetes.createCalls).toHaveLength(0);
  });

  it('rejects unauthorized webhook when secret configured', async () => {
    const { orchestrator } = createOrchestrator('secret');
    const result = await orchestrator.submitDevSpec({
      eventId: 'evt-unauth',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-9999',
      revision: 1,
      sddCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sddPath: '04-dev-specs/PAY-9999/dev-spec.yaml',
      devSpec: {
        ...sampleDevSpec,
        metadata: { ...sampleDevSpec.metadata, userStory: 'PAY-9999' },
      },
      webhookSecret: 'wrong',
    });
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.statusCode).toBe(401);
    }
  });

  it('moves PLANNING -> WAITING_SPEC_APPROVAL after planner completion', async () => {
    const { orchestrator } = createOrchestrator();
    const created = await orchestrator.submitDevSpec({
      eventId: 'evt-plan',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-2000',
      revision: 1,
      sddCommitSha: 'cccccccccccccccccccccccccccccccccccccccc',
      sddPath: '04-dev-specs/PAY-2000/dev-spec.yaml',
      devSpec: {
        ...sampleDevSpec,
        metadata: { ...sampleDevSpec.metadata, userStory: 'PAY-2000' },
      },
    });
    expect(created.outcome).toBe('created');

    const waiting = await orchestrator.completePlanner('WF#PAY-2000#1', {
      specHash:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      implementationSpecUri: 's3://hyperloop-artifacts/wf-PAY-2000-1/plan/spec.yaml',
    });

    expect(waiting.status).toBe('WAITING_SPEC_APPROVAL');
    expect(waiting.specHash).toContain('sha256:');
    expect(waiting.desiredJobs[0]?.status).toBe('SUCCEEDED');
  });
});
