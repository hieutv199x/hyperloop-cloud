import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '@hyperloop/integrations';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { WorkflowOrchestrator } from '../application/workflow-orchestrator.js';
import { EventConsumer } from './event-consumer.js';
import { normalizeSddSubmitted } from '@hyperloop/integrations';

describe('EventConsumer', () => {
  it('SDD_REVISION_SUBMITTED → workflow PLANNING + planner JOB_DESIRED', async () => {
    const bus = new InMemoryEventBus();
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

    const event = normalizeSddSubmitted({
      eventId: 'evt-consumer-1',
      occurredAt: '2026-10-27T12:00:00.000Z',
      project: 'payment-sdd',
      userStory: 'PAY-8100',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: '04-development/PAY-8100/dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'payment-sdd',
          userStory: 'PAY-8100',
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
              workingBranch: 'feature/PAY-8100',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    await bus.publish('devspec-events', event);
    const n = await consumer.pollOnce();
    expect(n).toBe(1);

    const workflow = await orchestrator.getWorkflow('WF#PAY-8100#1');
    expect(workflow?.status).toBe('PLANNING');
    expect(workflow?.desiredJobs.some((j) => j.stage === 'planner')).toBe(true);
    expect(kubernetes.createCalls.length).toBeGreaterThanOrEqual(1);
  });
});
