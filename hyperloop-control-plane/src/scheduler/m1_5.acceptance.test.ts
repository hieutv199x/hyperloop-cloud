import { describe, expect, it } from 'vitest';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';
import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import { JobQueueScheduler } from './job-queue-scheduler.js';
import { ReservationConflictError } from './atomic-store.js';

function config(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    ...DEFAULT_SCHEDULER_CONFIG,
    ...overrides,
    fairness: {
      ...DEFAULT_SCHEDULER_CONFIG.fairness,
      ...(overrides.fairness ?? {}),
    },
    priorities: {
      ...DEFAULT_SCHEDULER_CONFIG.priorities,
      ...(overrides.priorities ?? {}),
    },
    softTargets: {
      ...DEFAULT_SCHEDULER_CONFIG.softTargets,
      ...(overrides.softTargets ?? {}),
    },
    kubernetes: {
      ...DEFAULT_SCHEDULER_CONFIG.kubernetes,
      ...(overrides.kubernetes ?? {}),
    },
  };
}

async function enqueueMany(
  scheduler: JobQueueScheduler,
  count: number,
  stage: 'planner' | 'coding' | 'fix' = 'coding',
) {
  const specHash =
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  if (stage === 'coding') {
    scheduler.store.markSpecApproved('WF#LOAD', specHash);
  }
  for (let i = 0; i < count; i += 1) {
    await scheduler.enqueue({
      taskId: `task-${stage}-${i}`,
      workflowId: 'WF#LOAD',
      stage,
      project: 'transaction-banking',
      repository: `repo-${i % 10}`,
      approvedSpecHash: stage === 'coding' ? specHash : undefined,
    });
  }
}

describe('M1.5 acceptance / fault injection', () => {
  it('1) 150 ready tasks admit at most 100; >=50 remain queued', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config(), k8s, { queueBus: new InMemoryQueueBus() });
    await enqueueMany(scheduler, 150, 'coding');
    await scheduler.runUntilIdle(20);

    expect(scheduler.store.capacity.getState().used).toBe(100);
    expect(scheduler.store.activeReservationCount()).toBe(100);
    expect(scheduler.store.countByStatus('QUEUED')).toBe(50);
    expect(k8s.createCalls.length).toBe(100);
  });

  it('2) three scheduler replicas never over-admit or duplicate jobs', async () => {
    const k8s = new FakeKubernetesAdapter();
    const bus = new InMemoryQueueBus();
    const primary = new JobQueueScheduler(config(), k8s, { queueBus: bus });
    const r2 = primary.createReplica();
    const r3 = primary.createReplica();
    await enqueueMany(primary, 150, 'fix');

    await Promise.all([
      primary.runUntilIdle(30),
      r2.runUntilIdle(30),
      r3.runUntilIdle(30),
    ]);

    expect(primary.store.capacity.getState().used).toBeLessThanOrEqual(100);
    expect(primary.store.activeReservationCount()).toBeLessThanOrEqual(100);
    const uniqueJobs = new Set(k8s.createCalls);
    expect(uniqueJobs.size).toBe(k8s.createCalls.length);
    expect(uniqueJobs.size).toBe(100);
  });

  it('3) terminal release frees exactly one slot; duplicate terminal is no-op', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 2, 'planner');
    await scheduler.dispatchOnce();
    expect(scheduler.store.capacity.getState().used).toBe(1);

    const running = [...scheduler.store.tasks.values()].find((t) => t.status === 'SCHEDULED')!;
    k8s.setPhase('hyperloop-agents', running.k8sJobName!, 'Succeeded');

    const first = await scheduler.finalizeFromKubernetes(running.taskId);
    const second = await scheduler.finalizeFromKubernetes(running.taskId);
    expect(first).toBe('released');
    expect(second).toBe('already_released');
    expect(scheduler.store.capacity.getState().used).toBe(0);

    await scheduler.dispatchOnce();
    expect(scheduler.store.capacity.getState().used).toBe(1);
    expect(scheduler.store.countByStatus('QUEUED')).toBe(0);
  });

  it('4) reconciler creates exactly one job after reserve-before-create crash', async () => {
    const k8s = new FakeKubernetesAdapter({ createTimeoutFailures: 1 });
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 1, 'planner');

    const firstTick = await scheduler.dispatchOnce();
    expect(firstTick.reserved).toBe(1);
    expect(firstTick.dispatched).toBe(0); // create timed out
    expect(scheduler.store.getTask('task-planner-0')?.status).toBe('RESERVED');

    const fixed = await scheduler.reconciler.reconcileReserved();
    expect(fixed).toBe(1);
    expect(scheduler.store.getTask('task-planner-0')?.status).toBe('SCHEDULED');
    expect(k8s.createCountFor(scheduler.store.getTask('task-planner-0')!.k8sJobName!)).toBe(2);
  });

  it('5) k8s create timeout + deterministic lookup prevents duplicate jobs', async () => {
    const k8s = new FakeKubernetesAdapter({ createTimeoutFailures: 1 });
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 1, 'planner');
    await scheduler.dispatchOnce();
    await scheduler.reconciler.reconcileReserved();
    await scheduler.reconciler.reconcileReserved();

    const name = scheduler.store.getTask('task-planner-0')!.k8sJobName!;
    // first failed timeout (no persist), second create succeeds, further ensureExists hits exists
    expect(k8s.createCountFor(name)).toBeLessThanOrEqual(2);
    const job = await k8s.getJob('hyperloop-agents', name);
    expect(job.phase).toBe('Pending');
  });

  it('6) refuses release while Pending/Running; releases after Failed', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 1, 'planner');
    await scheduler.dispatchOnce();
    const task = scheduler.store.getTask('task-planner-0')!;
    k8s.setPhase('hyperloop-agents', task.k8sJobName!, 'Running');
    await scheduler.store.markRunning(task.taskId);

    await expect(scheduler.finalizeFromKubernetes(task.taskId)).rejects.toThrow(/still run/i);

    k8s.setPhase('hyperloop-agents', task.k8sJobName!, 'Failed');
    const released = await scheduler.reconciler.finalizeTerminalJobs();
    expect(released).toBe(1);
    expect(scheduler.store.capacity.getState().used).toBe(0);
  });

  it('7) duplicate wake-up messages do not double-reserve', async () => {
    const k8s = new FakeKubernetesAdapter();
    const bus = new InMemoryQueueBus();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s, {
      queueBus: bus,
    });
    await enqueueMany(scheduler, 1, 'planner');
    bus.publish('planner', 'task-planner-0');
    bus.publish('planner', 'task-planner-0');
    await scheduler.dispatchOnce();
    await scheduler.dispatchOnce();
    expect(scheduler.store.activeReservationCount()).toBe(1);
    expect(k8s.createCalls.length).toBe(1);
  });

  it('8) lost SQS wake-up recovered by durable DynamoDB scan', async () => {
    const k8s = new FakeKubernetesAdapter();
    const bus = new InMemoryQueueBus();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 5 }), k8s, {
      queueBus: bus,
    });
    await enqueueMany(scheduler, 3, 'planner');
    expect(bus.dropAll('planner')).toBe(3);
    expect(bus.depth('planner')).toBe(0);

    await scheduler.dispatchOnce();
    expect(scheduler.store.capacity.getState().used).toBe(3);
  });

  it('9) aging allows planner/coding through continuous fix backlog', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(
      config({
        globalMaxConcurrentJobs: 3,
        fairness: {
          agingEnabled: true,
          agingSecondsPerPoint: 1,
          perProjectLimit: null,
        },
        softTargets: { fix: 1, coding: 1, planner: 1 },
      }),
      k8s,
    );

    scheduler.store.markSpecApproved(
      'WF#AGE',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    for (let i = 0; i < 20; i += 1) {
      await scheduler.enqueue({
        taskId: `fix-${i}`,
        workflowId: 'WF#AGE',
        stage: 'fix',
      });
    }
    await scheduler.enqueue({
      taskId: 'planner-old',
      workflowId: 'WF#AGE',
      stage: 'planner',
    });
    await scheduler.enqueue({
      taskId: 'coding-old',
      workflowId: 'WF#AGE',
      stage: 'coding',
      approvedSpecHash:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    // Age planner/coding heavily
    const planner = scheduler.store.tasks.get('planner-old')!;
    const coding = scheduler.store.tasks.get('coding-old')!;
    planner.readyAt = new Date(Date.now() - 60_000).toISOString();
    coding.readyAt = new Date(Date.now() - 60_000).toISOString();

    await scheduler.dispatchOnce();
    const admitted = [...scheduler.store.tasks.values()].filter((t) =>
      ['RESERVED', 'SCHEDULED', 'RUNNING'].includes(t.status),
    );
    const stages = new Set(admitted.map((t) => t.stage));
    expect(stages.has('planner') || stages.has('coding')).toBe(true);
  });

  it('10) when full: no new jobs, suppressed busy-poll, queued durable', async () => {
    const k8s = new FakeKubernetesAdapter();
    const bus = new InMemoryQueueBus();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 2 }), k8s, {
      queueBus: bus,
    });
    await enqueueMany(scheduler, 5, 'planner');
    await scheduler.runUntilIdle(5);
    const creates = k8s.createCalls.length;
    expect(creates).toBe(2);

    const before = scheduler.metrics.busyPollSuppressedTotal;
    await scheduler.dispatchOnce();
    await scheduler.dispatchOnce();
    expect(scheduler.metrics.busyPollSuppressedTotal).toBeGreaterThan(before);
    expect(k8s.createCalls.length).toBe(creates);
    expect(scheduler.store.countByStatus('QUEUED')).toBe(3);
    expect(bus.pollCallsWhenFull).toBeGreaterThan(0);
  });

  it('11) cancel queued/reserved correctly; running requires terminate-then-release', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 2 }), k8s);
    await enqueueMany(scheduler, 3, 'planner');
    await scheduler.dispatchOnce();

    const queued = [...scheduler.store.tasks.values()].find((t) => t.status === 'QUEUED')!;
    await scheduler.cancelTask(queued.taskId);
    expect(scheduler.store.getTask(queued.taskId)?.status).toBe('CANCELLED');

    const scheduled = [...scheduler.store.tasks.values()].find((t) => t.status === 'SCHEDULED')!;
    const usedBefore = scheduler.store.capacity.getState().used;
    await scheduler.cancelTask(scheduled.taskId);
    expect(scheduler.store.getTask(scheduled.taskId)?.status).toBe('CANCELLED');
    expect(scheduler.store.capacity.getState().used).toBe(usedBefore - 1);
  });

  it('12) transaction conflicts never bypass quota', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 2, 'planner');
    await Promise.all([scheduler.dispatchOnce(), scheduler.createReplica().dispatchOnce()]);
    expect(scheduler.store.capacity.getState().used).toBe(1);
    expect(scheduler.store.activeReservationCount()).toBe(1);
  });

  it('13) coding cannot queue without exact approved spec hash; deps enforced', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config(), k8s);

    await expect(
      scheduler.enqueue({
        taskId: 'coding-1',
        workflowId: 'WF#HITL',
        stage: 'coding',
        approvedSpecHash:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ).rejects.toThrow(/HITL|approved spec hash/i);

    scheduler.store.markSpecApproved(
      'WF#HITL',
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    await expect(
      scheduler.enqueue({
        taskId: 'coding-dep',
        workflowId: 'WF#HITL',
        stage: 'coding',
        approvedSpecHash:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        dependsOn: ['missing-dep'],
      }),
    ).rejects.toThrow(/Dependency not satisfied/);
  });

  it('14) lowering limit below used blocks new admissions without killing running', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 5 }), k8s);
    await enqueueMany(scheduler, 5, 'planner');
    await scheduler.runUntilIdle(5);
    expect(scheduler.store.capacity.getState().used).toBe(5);

    scheduler.store.setCapacityLimit(2);
    await enqueueMany(scheduler, 3, 'fix');
    const createsBefore = k8s.createCalls.length;
    await scheduler.dispatchOnce();
    expect(k8s.createCalls.length).toBe(createsBefore);
    expect(scheduler.store.capacity.getState().used).toBe(5);
    expect(
      [...scheduler.store.tasks.values()].filter((t) => t.status === 'SCHEDULED').length,
    ).toBe(5);
  });

  it('capacity exhausted throws ReservationConflictError path', async () => {
    const k8s = new FakeKubernetesAdapter();
    const scheduler = new JobQueueScheduler(config({ globalMaxConcurrentJobs: 1 }), k8s);
    await enqueueMany(scheduler, 1, 'planner');
    await scheduler.dispatchOnce();
    await expect(scheduler.store.reserve('task-planner-0')).rejects.toBeInstanceOf(
      ReservationConflictError,
    );
  });
});
