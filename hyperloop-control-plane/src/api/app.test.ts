import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { WorkflowOrchestrator } from '../application/workflow-orchestrator.js';
import { buildApp } from './app.js';

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
    ],
    execution: {
      requireSpecApproval: true,
      maxAutoFixAttempts: 2,
    },
  },
};

describe('control-plane api M1', () => {
  it('returns health', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('accepts SDD webhook and returns workflow in PLANNING', async () => {
    const repository = new InMemoryWorkflowRepository();
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes: new FakeKubernetesAdapter(),
      agentNamespace: 'hyperloop-agents',
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
      webhookSecret: 'test-secret',
    });
    const app = buildApp({ orchestrator, webhookSecret: 'test-secret' });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'test-secret' },
      payload: {
        eventId: 'evt-api-1',
        occurredAt: '2026-10-27T05:00:00.000Z',
        project: 'transaction-banking',
        userStory: 'PAY-1234',
        revision: 1,
        sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
        devSpec,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      outcome: 'created',
      workflowId: 'WF#PAY-1234#1',
      status: 'PLANNING',
    });

    const get = await app.inject({ method: 'GET', url: '/workflows/WF%23PAY-1234%231' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ status: 'PLANNING' });
  });

  it('returns 200 duplicate for repeated eventId', async () => {
    const orchestrator = new WorkflowOrchestrator({
      repository: new InMemoryWorkflowRepository(),
      kubernetes: new FakeKubernetesAdapter(),
      agentNamespace: 'hyperloop-agents',
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
      webhookSecret: 'test-secret',
    });
    const app = buildApp({ orchestrator });

    const payload = {
      eventId: 'evt-api-dup',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-7777',
      revision: 1,
      sddCommitSha: 'dddddddddddddddddddddddddddddddddddddddd',
      sddPath: '04-dev-specs/PAY-7777/dev-spec.yaml',
      devSpec: {
        ...devSpec,
        metadata: { ...devSpec.metadata, userStory: 'PAY-7777' },
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'test-secret' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'test-secret' },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ outcome: 'duplicate' });
  });
});
