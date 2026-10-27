import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { CiDecisionService } from './ci-decision-service.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import type { WorkflowRecord } from '../domain/types.js';

const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA2 = 'cccccccccccccccccccccccccccccccccccccccc';

function baseWorkflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  const now = '2026-10-27T12:00:00.000Z';
  return {
    workflowId: 'WF#PAY-9000#1',
    project: 'payment-sdd',
    userStory: 'PAY-9000',
    revision: 1,
    status: 'AWAITING_CI',
    version: 1,
    sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sddPath: 'dev-spec.yaml',
    targets: [
      {
        repository: 'group/wallet-service',
        workingBranch: 'feature/PAY-9000',
        targetBranch: 'release/2.5.0',
      },
    ],
    services: {
      'group/wallet-service': {
        repository: 'group/wallet-service',
        workingBranch: 'feature/PAY-9000',
        targetBranch: 'release/2.5.0',
        dependsOn: [],
        state: 'AWAITING_CI',
        expectedCommitSha: SHA,
        mrIid: 42,
        fixAttempts: 0,
      },
    },
    specHash: 'spec-hash-1',
    approvals: [],
    desiredJobs: [],
    createdAt: now,
    updatedAt: now,
    timeline: [],
    ...overrides,
  };
}

async function setup(workflow: WorkflowRecord) {
  const repository = new InMemoryWorkflowRepository();
  await repository.createIfAbsent(workflow);
  const kubernetes = new FakeKubernetesAdapter();
  const orchestrator = new WorkflowOrchestrator({
    repository,
    kubernetes,
    agentNamespace: 'hyperloop-agents',
  });
  const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, kubernetes);
  const ci = new CiDecisionService(orchestrator, scheduler);
  return { repository, orchestrator, scheduler, ci };
}

describe('CiDecisionService', () => {
  it('pass path → READY_FOR_REVIEW', async () => {
    const { ci, orchestrator } = await setup(baseWorkflow());
    const result = await ci.handleCiResult({
      eventId: 'ci-1',
      workflowId: 'WF#PAY-9000#1',
      repository: 'group/wallet-service',
      mrIid: 42,
      commitSha: SHA,
      pipelineId: 'pipe-1',
      status: 'SUCCESS',
    });
    expect(result.action).toBe('pass');
    const wf = await orchestrator.getWorkflow('WF#PAY-9000#1');
    expect(wf?.status).toBe('READY_FOR_REVIEW');
    expect(wf?.services['group/wallet-service']?.state).toBe('READY');
  });

  it('stale SHA → no-op (zero Fix intents)', async () => {
    const { ci, scheduler } = await setup(baseWorkflow());
    const result = await ci.handleCiResult({
      eventId: 'ci-stale',
      workflowId: 'WF#PAY-9000#1',
      repository: 'group/wallet-service',
      mrIid: 42,
      commitSha: SHA2,
      pipelineId: 'pipe-stale',
      status: 'FAILURE',
      gateFailures: [
        { gate: 'unit', classification: 'fixable', message: 'fail' },
      ],
    });
    expect(result).toEqual({ action: 'noop', reason: 'stale_sha' });
    expect(scheduler.store.countByStatus('QUEUED')).toBe(0);
  });

  it('duplicate pipelineId → no-op (zero extra Fix intents)', async () => {
    const { ci, scheduler } = await setup(baseWorkflow());
    const input = {
      eventId: 'ci-dup-1',
      workflowId: 'WF#PAY-9000#1',
      repository: 'group/wallet-service',
      mrIid: 42,
      commitSha: SHA,
      pipelineId: 'pipe-dup',
      status: 'FAILURE' as const,
      gateFailures: [
        { gate: 'unit', classification: 'fixable' as const, message: 'fail' },
      ],
    };
    const first = await ci.handleCiResult(input);
    expect(first.action).toBe('fix_enqueued');
    const second = await ci.handleCiResult({ ...input, eventId: 'ci-dup-2' });
    expect(second).toEqual({ action: 'noop', reason: 'duplicate_pipeline' });
    expect(scheduler.store.countByStatus('QUEUED')).toBe(1);
  });

  it('fixable failure → enqueue Fix; exhaustion → NEEDS_HUMAN', async () => {
    const { ci, orchestrator, scheduler } = await setup(baseWorkflow());
    const fail = async (pipelineId: string, eventId: string) =>
      ci.handleCiResult({
        eventId,
        workflowId: 'WF#PAY-9000#1',
        repository: 'group/wallet-service',
        mrIid: 42,
        commitSha: SHA,
        pipelineId,
        status: 'FAILURE',
        gateFailures: [
          { gate: 'unit', classification: 'fixable', message: 'boom' },
        ],
        reportUri: 'https://ci.example/report',
      });

    expect((await fail('p1', 'e1')).action).toBe('fix_enqueued');
    // After fix job would push new SHA; simulate AWAITING_CI again with same SHA for attempt 2.
    const wf1 = await orchestrator.getWorkflow('WF#PAY-9000#1');
    wf1!.services['group/wallet-service']!.state = 'AWAITING_CI';
    wf1!.status = 'AWAITING_CI';
    const v1 = wf1!.version;
    await orchestrator.saveConditional(wf1!, v1);

    expect((await fail('p2', 'e2')).action).toBe('fix_enqueued');
    expect(scheduler.store.countByStatus('QUEUED')).toBe(2);

    const wf2 = await orchestrator.getWorkflow('WF#PAY-9000#1');
    wf2!.services['group/wallet-service']!.state = 'AWAITING_CI';
    wf2!.status = 'AWAITING_CI';
    await orchestrator.saveConditional(wf2!, wf2!.version);

    const third = await fail('p3', 'e3');
    expect(third.action).toBe('needs_human');
    if (third.action === 'needs_human') {
      expect(third.reason).toBe('fix_exhausted');
    }
    expect((await orchestrator.getWorkflow('WF#PAY-9000#1'))?.status).toBe('NEEDS_HUMAN');
    expect(scheduler.store.countByStatus('QUEUED')).toBe(2);
  });

  it('partial merge keeps workflow open; all merged → COMPLETED', async () => {
    const multi = baseWorkflow({
      status: 'READY_FOR_REVIEW',
      targets: [
        {
          repository: 'group/wallet-service',
          workingBranch: 'feature/PAY-9000',
          targetBranch: 'release/2.5.0',
        },
        {
          repository: 'group/ledger-service',
          workingBranch: 'feature/PAY-9000',
          targetBranch: 'release/2.5.0',
        },
      ],
      services: {
        'group/wallet-service': {
          repository: 'group/wallet-service',
          workingBranch: 'feature/PAY-9000',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
          state: 'READY',
          expectedCommitSha: SHA,
          mrIid: 42,
          fixAttempts: 0,
        },
        'group/ledger-service': {
          repository: 'group/ledger-service',
          workingBranch: 'feature/PAY-9000',
          targetBranch: 'release/2.5.0',
          dependsOn: ['group/wallet-service'],
          state: 'READY',
          expectedCommitSha: SHA2,
          mrIid: 43,
          fixAttempts: 0,
        },
      },
    });
    const { ci, orchestrator } = await setup(multi);

    const partial = await ci.handleMrMerged({
      eventId: 'mr-1',
      workflowId: 'WF#PAY-9000#1',
      repository: 'group/wallet-service',
      mrIid: 42,
      mergeCommitSha: 'd'.repeat(40),
    });
    expect(partial.action).toBe('service_merged');
    expect((await orchestrator.getWorkflow('WF#PAY-9000#1'))?.status).toBe(
      'READY_FOR_REVIEW',
    );

    const done = await ci.handleMrMerged({
      eventId: 'mr-2',
      workflowId: 'WF#PAY-9000#1',
      repository: 'group/ledger-service',
      mrIid: 43,
      mergeCommitSha: 'e'.repeat(40),
    });
    expect(done.action).toBe('workflow_completed');
    expect((await orchestrator.getWorkflow('WF#PAY-9000#1'))?.status).toBe('COMPLETED');
  });
});
