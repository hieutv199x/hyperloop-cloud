import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import { ExecutionFenceService } from './execution-fence-service.js';
import { buildApp } from '../api/app.js';

describe('ExecutionFenceService', () => {
  it('authorize-push allows issued token and 409 after fence / supersession', async () => {
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
    const fences = new ExecutionFenceService(repository);

    await orchestrator.submitDevSpec({
      eventId: 'evt-fence-1',
      occurredAt: new Date().toISOString(),
      project: 'payment-sdd',
      userStory: 'PAY-7000',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: 'dev-spec.yaml',
      sddProject: 'payment-sdd',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'payment-sdd',
          userStory: 'PAY-7000',
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
              workingBranch: 'feature/PAY-7000',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    const lease = await fences.issue({
      workflowId: 'WF#PAY-7000#1',
      jobId: 'WF#PAY-7000#1:coding:group/wallet-service:1',
      role: 'coding',
      repository: 'group/wallet-service',
    });

    const allowed = await fences.authorizePush({
      executionId: lease.executionId,
      fenceToken: lease.fenceToken,
    });
    expect(allowed.ok).toBe(true);

    await fences.fenceWorkflow('WF#PAY-7000#1', 'New SDD SHA supersedes prior execution');

    const denied = await fences.authorizePush({
      executionId: lease.executionId,
      fenceToken: lease.fenceToken,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.statusCode).toBe(409);
    }
  });

  it('HTTP authorize-push returns 409 when fenced', async () => {
    const repository = new InMemoryWorkflowRepository();
    const fences = new ExecutionFenceService(repository);
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

    await orchestrator.submitDevSpec({
      eventId: 'evt-fence-http',
      occurredAt: new Date().toISOString(),
      project: 'payment-sdd',
      userStory: 'PAY-7001',
      revision: 1,
      sddCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sddPath: 'dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'payment-sdd',
          userStory: 'PAY-7001',
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
              workingBranch: 'feature/x',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    const lease = await fences.issue({
      workflowId: 'WF#PAY-7001#1',
      jobId: 'job-1',
      role: 'coding',
    });
    await fences.fenceExecution(lease.executionId, 'superseded');

    const app = buildApp({
      orchestrator,
      fenceService: fences,
      workflowRepository: repository,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/executions/${encodeURIComponent(lease.executionId)}/authorize-push`,
      payload: { fenceToken: lease.fenceToken },
    });
    expect(response.statusCode).toBe(409);
  });
});
