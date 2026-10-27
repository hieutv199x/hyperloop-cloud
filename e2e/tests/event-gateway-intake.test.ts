import { describe, expect, it } from 'vitest';
import {
  buildEventGateway,
  InMemoryEventBus,
} from '@hyperloop/integrations';
import { InMemoryWorkflowRepository } from '../../hyperloop-control-plane/src/adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../../hyperloop-control-plane/src/adapters/kubernetes/fake-kubernetes.js';
import { WorkflowOrchestrator } from '../../hyperloop-control-plane/src/application/workflow-orchestrator.js';
import { EventConsumer } from '../../hyperloop-control-plane/src/workers/event-consumer.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('e2e Event Gateway → CP consumer', () => {
  it('webhook → queue → submitDevSpec → planner Job desired', async () => {
    const bus = new InMemoryEventBus();
    const gateway = buildEventGateway({
      eventBus: bus,
      gitlabWebhookSecret: 'secret',
    });
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
    });
    const consumer = new EventConsumer({ eventBus: bus, orchestrator });

    const accepted = await gateway.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'secret' },
      payload: {
        eventId: 'evt-e2e-gw-1',
        occurredAt: '2026-10-27T12:00:00.000Z',
        project: 'payment-sdd',
        userStory: 'PAY-8200',
        revision: 1,
        sddCommitSha: SHA,
        sddPath: '04-development/PAY-8200/dev-spec.yaml',
        changedPaths: ['04-development/PAY-8200/dev-spec.yaml'],
        devSpec: {
          apiVersion: 'hyperloop.dev/v1',
          kind: 'DevelopmentSpec',
          metadata: {
            project: 'payment-sdd',
            userStory: 'PAY-8200',
            revision: 1,
          },
          spec: {
            status: 'submitted',
            requirements: ['r.md'],
            designs: ['d.md'],
            acceptanceCriteria: ['ac.md'],
            targets: [
              {
                repository: 'group/wallet-service',
                workingBranch: 'feature/PAY-8200',
                targetBranch: 'release/2.5.0',
              },
            ],
            execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
          },
        },
      },
    });
    expect(accepted.statusCode).toBe(202);

    await consumer.pollOnce();
    const workflow = await orchestrator.getWorkflow('WF#PAY-8200#1');
    expect(workflow?.status).toBe('PLANNING');
    expect(workflow?.desiredJobs[0]?.stage).toBe('planner');
    expect(kubernetes.createCalls.length).toBeGreaterThanOrEqual(1);
  });
});
