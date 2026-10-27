import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, normalizeCiResult } from '@hyperloop/integrations';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { EventConsumer } from '../workers/event-consumer.js';
import { CiDecisionService } from './ci-decision-service.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import type { WorkflowRecord } from '../domain/types.js';

const SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function awaitingCiWorkflow(): WorkflowRecord {
  const now = '2026-10-27T15:00:00.000Z';
  return {
    workflowId: 'WF#PAY-M7#1',
    project: 'payment-sdd',
    userStory: 'PAY-M7',
    revision: 1,
    status: 'AWAITING_CI',
    version: 1,
    sddCommitSha: 'a'.repeat(40),
    sddPath: 'dev-spec.yaml',
    targets: [
      {
        repository: 'group/wallet',
        workingBranch: 'feature/PAY-M7',
        targetBranch: 'release/2.5.0',
      },
    ],
    services: {
      'group/wallet': {
        repository: 'group/wallet',
        workingBranch: 'feature/PAY-M7',
        targetBranch: 'release/2.5.0',
        dependsOn: [],
        state: 'AWAITING_CI',
        expectedCommitSha: SHA,
        mrIid: 11,
        fixAttempts: 0,
      },
    },
    specHash: 'spec-m7',
    approvals: [],
    desiredJobs: [],
    createdAt: now,
    updatedAt: now,
    timeline: [],
  };
}

describe('M7 hardening', () => {
  it('scheduler restart: reconcileReserved is idempotent (no duplicate Jobs)', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, k8s);
    await scheduler.enqueue({
      taskId: 'task-m7-1',
      workflowId: 'WF#PAY-M7#1',
      stage: 'planner',
    });
    await scheduler.dispatchOnce();
    const createsAfterDispatch = k8s.createCalls.length;

    // Simulate controller crash + restart: reconcile again.
    const fixed1 = await scheduler.reconciler.reconcileReserved();
    const fixed2 = await scheduler.reconciler.reconcileReserved();
    expect(fixed1).toBeGreaterThanOrEqual(0);
    expect(fixed2).toBeGreaterThanOrEqual(0);
    expect(k8s.createCalls.length).toBe(createsAfterDispatch);
  });

  it('cancel is safe for QUEUED and SCHEDULED; slot released once', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(
      { ...DEFAULT_SCHEDULER_CONFIG, globalMaxConcurrentJobs: 1 },
      k8s,
    );
    await scheduler.enqueue({
      taskId: 'task-q',
      workflowId: 'WF#1',
      stage: 'planner',
    });
    await scheduler.enqueue({
      taskId: 'task-s',
      workflowId: 'WF#1',
      stage: 'planner',
    });
    await scheduler.dispatchOnce();
    const scheduled = [...scheduler.store.tasks.values()].find((t) =>
      ['SCHEDULED', 'RESERVED', 'RUNNING'].includes(t.status),
    );
    const queued = [...scheduler.store.tasks.values()].find((t) => t.status === 'QUEUED');
    expect(scheduled).toBeTruthy();
    expect(queued).toBeTruthy();

    const usedBefore = scheduler.store.capacity.getState().used;
    await scheduler.cancelTask(queued!.taskId);
    await scheduler.cancelTask(scheduled!.taskId);
    expect(scheduler.store.getTask(queued!.taskId)?.status).toBe('CANCELLED');
    expect(scheduler.store.getTask(scheduled!.taskId)?.status).toBe('CANCELLED');
    expect(scheduler.store.capacity.getState().used).toBe(usedBefore - 1);

    // Second cancel on already-terminal must fail closed.
    await expect(scheduler.cancelTask(queued!.taskId)).rejects.toThrow();
  });

  it('event consumer wires CiDecision: CI pass after restart of consumer process', async () => {
    const repository = new InMemoryWorkflowRepository();
    await repository.createIfAbsent(awaitingCiWorkflow());
    const k8s = new FakeKubernetesAdapter();
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes: k8s,
      agentNamespace: 'hyperloop-agents',
    });
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, k8s);
    const ci = new CiDecisionService(orchestrator, scheduler);
    const bus = new InMemoryEventBus();

    // Consumer process A dies before poll; process B picks up the same durable message.
    const consumerB = new EventConsumer({ eventBus: bus, orchestrator, ciDecision: ci });
    await bus.publish(
      'devspec-events',
      normalizeCiResult({
        eventId: 'ci-m7-1',
        occurredAt: '2026-10-27T15:01:00.000Z',
        workflowId: 'WF#PAY-M7#1',
        repository: 'group/wallet',
        mrIid: 11,
        commitSha: SHA,
        pipelineId: 'pipe-m7',
        status: 'SUCCESS',
      }),
    );
    expect(await consumerB.pollOnce()).toBe(1);
    const wf = await orchestrator.getWorkflow('WF#PAY-M7#1');
    expect(wf?.status).toBe('READY_FOR_REVIEW');

    // Duplicate delivery after restart → no-op (pipeline already seen).
    await bus.publish(
      'devspec-events',
      normalizeCiResult({
        eventId: 'ci-m7-1-retry',
        occurredAt: '2026-10-27T15:02:00.000Z',
        workflowId: 'WF#PAY-M7#1',
        repository: 'group/wallet',
        mrIid: 11,
        commitSha: SHA,
        pipelineId: 'pipe-m7',
        status: 'SUCCESS',
      }),
    );
    const consumerC = new EventConsumer({ eventBus: bus, orchestrator, ciDecision: ci });
    expect(await consumerC.pollOnce()).toBe(1);
    expect((await orchestrator.getWorkflow('WF#PAY-M7#1'))?.version).toBe(wf?.version);
  });

  it('activeDeadline timeout path releases slot via finalizeTerminalJobs', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, k8s);
    await scheduler.enqueue({
      taskId: 'task-timeout',
      workflowId: 'WF#1',
      stage: 'planner',
    });
    await scheduler.dispatchOnce();
    const task = scheduler.store.getTask('task-timeout')!;
    // Simulate Job deadline exceeded → Failed
    k8s.setPhase(DEFAULT_SCHEDULER_CONFIG.kubernetes.namespace, task.k8sJobName!, 'Failed');
    const released = await scheduler.reconciler.finalizeTerminalJobs();
    expect(released).toBe(1);
    expect(scheduler.store.capacity.getState().used).toBe(0);
    // Idempotent finalize
    expect(await scheduler.reconciler.finalizeTerminalJobs()).toBe(0);
  });
});
