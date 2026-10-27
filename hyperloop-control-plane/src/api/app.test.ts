import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { WorkflowOrchestrator } from '../application/workflow-orchestrator.js';
import { buildApp } from './app.js';

describe('control-plane api', () => {
  it('returns health', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('exposes workflow read API after orchestrator submit', async () => {
    const repository = new InMemoryWorkflowRepository();
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes: new FakeKubernetesAdapter(),
      agentNamespace: 'hyperloop-agents',
      agentImages: {
        planner: 'nexus.example/hyperloop/kiro-agent-planner:0.1.0',
        coding: 'nexus.example/hyperloop/kiro-agent-coding:0.1.0',
        fix: 'nexus.example/hyperloop/kiro-agent-fix:0.1.0',
      },
    });
    const app = buildApp({ orchestrator, workflowRepository: repository });

    await orchestrator.submitDevSpec({
      eventId: 'evt-api-1',
      occurredAt: '2026-10-27T05:00:00.000Z',
      project: 'transaction-banking',
      userStory: 'PAY-1234',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-dev-specs/PAY-1234/dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'transaction-banking',
          userStory: 'PAY-1234',
          revision: 1,
        },
        spec: {
          status: 'submitted',
          requirements: ['r.md'],
          designs: ['d.md'],
          acceptanceCriteria: ['ac.md'],
          targets: [
            {
              repository: 'coc-ewallet-service',
              workingBranch: 'feature/PAY-1234',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    const get = await app.inject({ method: 'GET', url: '/workflows/WF%23PAY-1234%231' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ status: 'PLANNING' });
  });

  it('does not expose webhook routes (Event Gateway owns them)', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
