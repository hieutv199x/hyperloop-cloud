import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import type { InMemoryQueueBus } from '../workers/in-memory-queue.js';
import { AtomicSchedulerStore, ReservationConflictError } from './atomic-store.js';
import type { SchedulerConfig } from './config.js';
import { JobReconciler } from './job-reconciler.js';
import { JobReservationService } from './job-reservation-service.js';
import { KubernetesJobDispatcher } from './kubernetes-job-dispatcher.js';
import { SchedulerMetrics } from './metrics.js';
import { PriorityPolicy } from './priority-policy.js';
import type { EnqueueTaskInput, ReadyTask } from './types.js';

export interface SchedulerDeps {
  store?: AtomicSchedulerStore;
  metrics?: SchedulerMetrics;
  queueBus?: InMemoryQueueBus;
}

export class JobQueueScheduler {
  readonly store: AtomicSchedulerStore;
  readonly metrics: SchedulerMetrics;
  readonly policy: PriorityPolicy;
  readonly reservations: JobReservationService;
  readonly dispatcher: KubernetesJobDispatcher;
  readonly reconciler: JobReconciler;
  private readonly queueBus?: InMemoryQueueBus;

  constructor(
    readonly config: SchedulerConfig,
    private readonly kubernetes: KubernetesJobPort,
    deps: SchedulerDeps = {},
  ) {
    this.store = deps.store ?? new AtomicSchedulerStore(config);
    this.metrics = deps.metrics ?? new SchedulerMetrics();
    this.queueBus = deps.queueBus;
    this.policy = new PriorityPolicy(config);
    this.reservations = new JobReservationService(this.store);
    this.dispatcher = new KubernetesJobDispatcher(kubernetes, config);
    this.reconciler = new JobReconciler(
      this.store,
      kubernetes,
      this.reservations,
      config,
      this.metrics,
    );
  }

  /** Additional replica sharing durable store + metrics + queues. */
  createReplica(): JobQueueScheduler {
    return new JobQueueScheduler(this.config, this.kubernetes, {
      store: this.store,
      metrics: this.metrics,
      queueBus: this.queueBus,
    });
  }

  async enqueue(input: EnqueueTaskInput): Promise<ReadyTask> {
    const task = await this.store.enqueue(input, this.policy);
    this.queueBus?.publish(task.stage, task.taskId);
    this.refreshMetrics();
    return task;
  }

  /**
   * One scheduling tick. Safe for concurrent replica calls via store lock.
   */
  async dispatchOnce(): Promise<{ reserved: number; dispatched: number }> {
    if (this.capacityFull()) {
      this.metrics.busyPollSuppressedTotal += 1;
      if (this.queueBus) {
        for (const stage of ['planner', 'coding', 'fix'] as const) {
          this.queueBus.receive(stage, 10, true);
        }
      }
      this.refreshMetrics();
      return { reserved: 0, dispatched: 0 };
    }

    if (this.queueBus) {
      for (const stage of ['planner', 'coding', 'fix'] as const) {
        this.queueBus.receive(stage, 10, false);
      }
    }

    const queued = this.store.listQueued();
    const ranked = this.policy.rank(queued);
    const available = this.store.capacity.snapshot(this.store.activeByStage()).available;
    const softActive = this.store.activeByStage();
    const candidates = this.policy.selectCandidates(ranked, { ...softActive }, available);

    let reserved = 0;
    let dispatched = 0;

    for (const task of candidates) {
      const reservation = await this.reservations.reserveWithBackoff(task.taskId);
      if (!reservation) {
        continue;
      }
      reserved += 1;
      try {
        await this.dispatcher.dispatch(task, reservation);
        await this.store.markScheduled(task.taskId);
        dispatched += 1;
      } catch {
        this.metrics.schedulerDispatchFailuresTotal += 1;
        // Keep RESERVED; reconciler repairs via deterministic job name.
      }
    }

    this.refreshMetrics();
    return { reserved, dispatched };
  }

  async runUntilIdle(maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i += 1) {
      const beforeQueued = this.store.countByStatus('QUEUED');
      const result = await this.dispatchOnce();
      await this.reconciler.reconcileReserved();
      if (result.reserved === 0 && this.store.countByStatus('QUEUED') === beforeQueued) {
        if (this.capacityFull() || beforeQueued === 0) break;
      }
    }
    this.refreshMetrics();
  }

  capacityFull(): boolean {
    const snap = this.store.capacity.getState();
    return snap.used >= snap.limit;
  }

  refreshMetrics(): void {
    const snap = this.store.capacity.snapshot(this.store.activeByStage());
    this.metrics.slotsUsed = snap.used;
    this.metrics.slotsAvailable = snap.available;
    this.metrics.queueDepth = this.store.countByStatus('QUEUED');
    this.metrics.jobPending = this.store.countByStatus('SCHEDULED');
    this.metrics.jobRunning = this.store.countByStatus('RUNNING');
  }

  async finalizeFromKubernetes(taskId: string): Promise<'released' | 'already_released'> {
    const task = this.store.getTask(taskId);
    if (!task?.k8sJobName) {
      throw new Error(`No k8s job for task ${taskId}`);
    }
    const observed = await this.kubernetes.getJob(
      this.config.kubernetes.namespace,
      task.k8sJobName,
    );
    if (observed.phase === 'Running' || observed.phase === 'Pending') {
      throw new Error('Refusing to release while job may still run');
    }
    const terminal = observed.phase === 'Succeeded' ? 'SUCCEEDED' : 'FAILED';
    const result = await this.reservations.releaseOnce(taskId, terminal);
    this.refreshMetrics();
    return result;
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.status === 'QUEUED') {
      await this.store.cancelQueued(taskId);
      this.refreshMetrics();
      return;
    }

    if (['RESERVED', 'SCHEDULED', 'RUNNING'].includes(task.status) && task.k8sJobName) {
      await this.kubernetes.deleteJob(this.config.kubernetes.namespace, task.k8sJobName);
      const observed = await this.kubernetes.getJob(
        this.config.kubernetes.namespace,
        task.k8sJobName,
      );
      if (observed.phase === 'Running' || observed.phase === 'Pending') {
        throw new ReservationConflictError('Job still observable as active after delete');
      }
      await this.reservations.releaseOnce(taskId, 'CANCELLED');
      this.refreshMetrics();
      return;
    }

    throw new Error(`Cannot cancel task in status ${task.status}`);
  }
}
