import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { ApproverPolicy } from '../security/approver-policy.js';
import { ApprovalService } from './approval-service.js';
import { ApprovalError, WorkflowOrchestrator } from './workflow-orchestrator.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SPEC2 =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SDD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const devSpec = {
  apiVersion: 'hyperloop.dev/v1',
  kind: 'DevelopmentSpec',
  metadata: { project: 'transaction-banking', userStory: 'PAY-3000', revision: 1 },
  spec: {
    status: 'submitted',
    requirements: ['r.md'],
    designs: ['d.md'],
    acceptanceCriteria: ['ac.md'],
    targets: [
      {
        repository: 'coc-ewallet-service',
        workingBranch: 'feature/PAY-3000',
        targetBranch: 'release/2.5.0',
      },
      {
        repository: 'access-control-adapter',
        workingBranch: 'feature/PAY-3000',
        targetBranch: 'release/2.5.0',
      },
    ],
    execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
  },
};

async function setup(allowlist: string[] = ['entra-alice']) {
  const repository = new InMemoryWorkflowRepository();
  const kubernetes = new FakeKubernetesAdapter();
  const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, kubernetes);
  const orchestrator = new WorkflowOrchestrator({
    repository,
    kubernetes,
    agentNamespace: 'hyperloop-agents',
    agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
    approverPolicy: ApproverPolicy.fromAllowlist(allowlist),
    onApprovalsInvalidated: (workflowId) => {
      scheduler.store.clearSpecApproval(workflowId);
    },
  });
  const approvals = new ApprovalService(orchestrator, scheduler);

  await orchestrator.submitDevSpec({
    eventId: 'evt-m3',
    occurredAt: new Date().toISOString(),
    project: 'transaction-banking',
    userStory: 'PAY-3000',
    revision: 1,
    sddCommitSha: SDD_SHA,
    sddPath: 'dev-spec.yaml',
    devSpec,
  });
  await orchestrator.completePlanner('WF#PAY-3000#1', {
    specHash: SPEC,
    implementationSpecUri: 's3://hyperloop-artifacts/wf/plan.json',
    planServices: [
      {
        repository: 'coc-ewallet-service',
        workingBranch: 'feature/PAY-3000',
        targetBranch: 'release/2.5.0',
        dependsOn: [],
      },
      {
        repository: 'access-control-adapter',
        workingBranch: 'feature/PAY-3000',
        targetBranch: 'release/2.5.0',
        dependsOn: ['coc-ewallet-service'],
      },
    ],
  });

  return { orchestrator, scheduler, approvals };
}

describe('M3 HITL approval', () => {
  it('blocks coding enqueue before approval', async () => {
    const { scheduler, orchestrator } = await setup();
    const workflow = await orchestrator.getWorkflow('WF#PAY-3000#1');
    expect(workflow?.status).toBe('WAITING_SPEC_APPROVAL');

    await expect(
      scheduler.enqueue({
        taskId: 'coding-early',
        workflowId: 'WF#PAY-3000#1',
        stage: 'coding',
        approvedSpecHash: SPEC,
      }),
    ).rejects.toThrow(/HITL|approved spec hash/i);
  });

  it('approves exact specHash + sddCommitSha and enqueues only DAG roots', async () => {
    const { approvals, scheduler, orchestrator } = await setup();
    const before = await orchestrator.getWorkflow('WF#PAY-3000#1');

    const result = await approvals.approve({
      workflowId: 'WF#PAY-3000#1',
      approvedSpecHash: SPEC,
      approvedSddCommitSha: SDD_SHA,
      decision: 'APPROVED',
      expectedVersion: before!.version,
      approver: { entraId: 'entra-alice', displayName: 'Alice' },
    });

    expect(result.workflow.status).toBe('CODING');
    expect(result.codingTasksEnqueued).toEqual([
      'WF#PAY-3000#1:coding:coc-ewallet-service:1',
    ]);
    expect(scheduler.store.getTask(result.codingTasksEnqueued[0]!)?.status).toBe('QUEUED');
  });

  it('rejects wrong specHash, wrong SDD SHA, and unauthorized approver', async () => {
    const { approvals, orchestrator } = await setup(['entra-alice']);
    const before = await orchestrator.getWorkflow('WF#PAY-3000#1');

    await expect(
      approvals.approve({
        workflowId: 'WF#PAY-3000#1',
        approvedSpecHash: SPEC2,
        approvedSddCommitSha: SDD_SHA,
        decision: 'APPROVED',
        expectedVersion: before!.version,
        approver: { entraId: 'entra-alice', displayName: 'Alice' },
      }),
    ).rejects.toBeInstanceOf(ApprovalError);

    await expect(
      approvals.approve({
        workflowId: 'WF#PAY-3000#1',
        approvedSpecHash: SPEC,
        approvedSddCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        decision: 'APPROVED',
        expectedVersion: before!.version,
        approver: { entraId: 'entra-alice', displayName: 'Alice' },
      }),
    ).rejects.toBeInstanceOf(ApprovalError);

    await expect(
      approvals.approve({
        workflowId: 'WF#PAY-3000#1',
        approvedSpecHash: SPEC,
        approvedSddCommitSha: SDD_SHA,
        decision: 'APPROVED',
        expectedVersion: before!.version,
        approver: { entraId: 'entra-bob', displayName: 'Bob' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('invalidates prior approval when spec hash changes', async () => {
    const { approvals, orchestrator, scheduler } = await setup();
    const before = await orchestrator.getWorkflow('WF#PAY-3000#1');
    await approvals.approve({
      workflowId: 'WF#PAY-3000#1',
      approvedSpecHash: SPEC,
      approvedSddCommitSha: SDD_SHA,
      decision: 'APPROVED',
      expectedVersion: before!.version,
      approver: { entraId: 'entra-alice', displayName: 'Alice' },
    });

    const updated = await orchestrator.completePlanner('WF#PAY-3000#1', {
      specHash: SPEC2,
      implementationSpecUri: 's3://hyperloop-artifacts/wf/plan-v2.json',
    });

    expect(updated.status).toBe('WAITING_SPEC_APPROVAL');
    expect(updated.approvals[0]?.invalidatedAt).toBeTruthy();
    expect(orchestrator.hasValidApproval(updated)).toBe(false);

    await expect(
      scheduler.enqueue({
        taskId: 'coding-after-change',
        workflowId: 'WF#PAY-3000#1',
        stage: 'coding',
        approvedSpecHash: SPEC,
      }),
    ).rejects.toThrow(/HITL|approved spec hash/i);
  });

  it('only one of two concurrent approvals wins', async () => {
    const { approvals, orchestrator } = await setup(['*']);
    const before = await orchestrator.getWorkflow('WF#PAY-3000#1');
    const payload = {
      workflowId: 'WF#PAY-3000#1',
      approvedSpecHash: SPEC,
      approvedSddCommitSha: SDD_SHA,
      decision: 'APPROVED' as const,
      expectedVersion: before!.version,
      approver: { entraId: 'entra-alice', displayName: 'Alice' },
    };

    const results = await Promise.allSettled([
      approvals.approve(payload),
      approvals.approve({
        ...payload,
        approver: { entraId: 'entra-carol', displayName: 'Carol' },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const workflow = await orchestrator.getWorkflow('WF#PAY-3000#1');
    expect(workflow?.status).toBe('CODING');
    expect(workflow?.approvals.filter((a) => !a.invalidatedAt)).toHaveLength(1);
  });
});
