import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import type { AtomicSchedulerStore } from './atomic-store.js';
import type { SchedulerConfig } from './config.js';
import { KubernetesJobDispatcher } from './kubernetes-job-dispatcher.js';
import { JobReservationService } from './job-reservation-service.js';
import type { SchedulerMetrics } from './metrics.js';

export class JobReconciler {
  private readonly dispatcher: KubernetesJobDispatcher;

  constructor(
    private readonly store: AtomicSchedulerStore,
    private readonly kubernetes: KubernetesJobPort,
    private readonly reservations: JobReservationService,
    private readonly config: SchedulerConfig,
    private readonly metrics: SchedulerMetrics,
  ) {
    this.dispatcher = new KubernetesJobDispatcher(kubernetes, config);
  }

  /**
   * Crash safety: after RESERVED + desired job persisted, ensure K8s Job exists.
   * Lookup by deterministic name before create to avoid duplicates on timeout.
   */
  async reconcileReserved(): Promise<number> {
    let fixed = 0;
    const missing = this.store.listActiveReservationsMissingSchedule();
    for (const { task, reservation } of missing) {
      const observed = await this.kubernetes.getJob(
        this.config.kubernetes.namespace,
        reservation.k8sJobName,
      );
      if (observed.phase === 'NotFound') {
        await this.dispatcher.ensureExists(task, reservation);
        await this.store.markScheduled(task.taskId);
        fixed += 1;
        this.metrics.reservationReconciliationTotal += 1;
      } else if (task.status === 'RESERVED') {
        await this.store.markScheduled(task.taskId);
        fixed += 1;
        this.metrics.reservationReconciliationTotal += 1;
      }
    }
    return fixed;
  }

  /**
   * Terminal finalizer: release slot only after verified non-running state.
   * Lost heartbeat alone is not proof of stop — require Succeeded/Failed/NotFound
   * after ownership check.
   */
  async finalizeTerminalJobs(): Promise<number> {
    let released = 0;
    for (const task of [...this.store.tasks.values()]) {
      if (!['RESERVED', 'SCHEDULED', 'RUNNING'].includes(task.status) || !task.k8sJobName) {
        continue;
      }
      const observed = await this.kubernetes.getJob(
        this.config.kubernetes.namespace,
        task.k8sJobName,
      );
      if (observed.phase === 'Running') {
        await this.store.markRunning(task.taskId);
        continue;
      }
      if (observed.phase === 'Pending') {
        continue;
      }
      if (observed.phase === 'Succeeded') {
        const result = await this.reservations.releaseOnce(task.taskId, 'SUCCEEDED');
        if (result === 'released') released += 1;
      } else if (observed.phase === 'Failed') {
        const result = await this.reservations.releaseOnce(task.taskId, 'FAILED');
        if (result === 'released') released += 1;
      } else if (observed.phase === 'NotFound') {
        // Only release NotFound when desired ownership is RESERVED/SCHEDULED
        // and reconciler already attempted ensure — treat as abandoned failure.
        if (task.status === 'SCHEDULED' || task.status === 'RUNNING') {
          const result = await this.reservations.releaseOnce(task.taskId, 'FAILED');
          if (result === 'released') released += 1;
        }
      }
    }
    return released;
  }
}
