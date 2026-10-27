import { describe, expect, it } from 'vitest';
import { InMemoryGitLabClient } from '@hyperloop/integrations';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { InMemoryArtifactStore } from '../adapters/s3/artifact-store.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { ApproverPolicy } from '../security/approver-policy.js';
import { ApprovalService } from './approval-service.js';
import { CodingVerticalSlice } from './coding-vertical-slice.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('M4 coding vertical slice', () => {
  it('approved plan → coding job → MR to release → AWAITING_CI; unlocks dependent', async () => {
    const repository = new InMemoryWorkflowRepository();
    const kubernetes = new FakeKubernetesAdapter();
    const artifacts = new InMemoryArtifactStore();
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, kubernetes);
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes,
      agentNamespace: 'hyperloop-agents',
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
      approverPolicy: ApproverPolicy.allowAllForDev(),
      onApprovalsInvalidated: (id) => scheduler.store.clearSpecApproval(id),
    });
    const approvals = new ApprovalService(orchestrator, scheduler);
    const gitlab = new InMemoryGitLabClient(
      new Set(['coc-ewallet-service', 'access-control-adapter']),
      [
        { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
        { projectId: 'access-control-adapter', name: 'release/2.5.0' },
      ],
    );

    await orchestrator.submitDevSpec({
      eventId: 'evt-m4',
      occurredAt: new Date().toISOString(),
      project: 'transaction-banking',
      userStory: 'PAY-4000',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: 'dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'transaction-banking',
          userStory: 'PAY-4000',
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
              workingBranch: 'feature/PAY-4000',
              targetBranch: 'release/2.5.0',
            },
            {
              repository: 'access-control-adapter',
              workingBranch: 'feature/PAY-4000',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    await orchestrator.completePlanner('WF#PAY-4000#1', {
      specHash: SPEC,
      implementationSpecUri: 's3://hyperloop-artifacts/plan.json',
      planServices: [
        {
          repository: 'coc-ewallet-service',
          workingBranch: 'feature/PAY-4000',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
        },
        {
          repository: 'access-control-adapter',
          workingBranch: 'feature/PAY-4000',
          targetBranch: 'release/2.5.0',
          dependsOn: ['coc-ewallet-service'],
        },
      ],
    });

    const waiting = await orchestrator.getWorkflow('WF#PAY-4000#1');
    const approved = await approvals.approve({
      workflowId: 'WF#PAY-4000#1',
      approvedSpecHash: SPEC,
      approvedSddCommitSha: waiting!.sddCommitSha,
      decision: 'APPROVED',
      expectedVersion: waiting!.version,
      approver: { entraId: 'entra-alice', displayName: 'Alice' },
    });

    expect(approved.codingTasksEnqueued).toEqual([
      'WF#PAY-4000#1:coding:coc-ewallet-service:1',
    ]);

    const slice = new CodingVerticalSlice({
      orchestrator,
      approvals,
      scheduler,
      kubernetes,
      artifacts,
      artifactsBucket: 'hyperloop-artifacts',
      agentNamespace: 'hyperloop-agents',
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
      gitlab,
    });

    const coded = await slice.runTask(approved.codingTasksEnqueued[0]!);
    expect(coded.mrIid).toBe(1);
    expect(coded.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(coded.workflow.services['coc-ewallet-service']?.state).toBe('AWAITING_CI');
    expect(coded.workflow.services['coc-ewallet-service']?.mrIid).toBe(1);
    expect(coded.newlyUnlocked).toEqual(['access-control-adapter']);
    expect(gitlab.mergeRequests[0]?.targetBranch).toBe('release/2.5.0');

    const dependentTask = scheduler.store.getTask(
      'WF#PAY-4000#1:coding:access-control-adapter:1',
    );
    expect(dependentTask?.status).toBe('QUEUED');

    // Pod/Job terminated (slot released)
    expect(scheduler.store.capacity.getState().used).toBe(0);
  });
});
