import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { loadConfig } from '../config.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';

/**
 * Control Plane Scheduler process (v1.3): wake-up poll + reconcile loop.
 * Same image as API; selected via `node dist/index.js scheduler`.
 * Returns when SIGTERM/SIGINT is received (after draining timers).
 */
export async function startScheduler(): Promise<void> {
  const config = loadConfig();
  const kubernetes = new FakeKubernetesAdapter();
  const queueBus = new InMemoryQueueBus();
  const scheduler = new JobQueueScheduler(
    {
      ...DEFAULT_SCHEDULER_CONFIG,
      globalMaxConcurrentJobs: config.GLOBAL_MAX_CONCURRENT_JOBS,
      pollIntervalSeconds: Number(process.env.SCHEDULER_POLL_INTERVAL_SECONDS ?? 5),
      reconciliationIntervalSeconds: Number(
        process.env.SCHEDULER_RECONCILE_INTERVAL_SECONDS ?? 30,
      ),
      kubernetes: {
        ...DEFAULT_SCHEDULER_CONFIG.kubernetes,
        namespace: config.AGENT_NAMESPACE,
        images: config.agentImages,
        imageAllowlist: [...config.agentImageAllowlist],
      },
    },
    kubernetes,
    { queueBus },
  );

  let stopping = false;
  let dispatchTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;

  const pollMs = scheduler.config.pollIntervalSeconds * 1000;
  const reconcileMs = scheduler.config.reconciliationIntervalSeconds * 1000;

  const tickDispatch = async () => {
    if (stopping) return;
    try {
      await scheduler.dispatchOnce();
    } catch (error) {
      console.error('[scheduler] dispatchOnce failed', error);
    }
  };

  const tickReconcile = async () => {
    if (stopping) return;
    try {
      await scheduler.reconciler.reconcileReserved();
      scheduler.refreshMetrics();
    } catch (error) {
      console.error('[scheduler] reconcile failed', error);
    }
  };

  console.log(
    `[scheduler] started poll=${scheduler.config.pollIntervalSeconds}s reconcile=${scheduler.config.reconciliationIntervalSeconds}s limit=${scheduler.config.globalMaxConcurrentJobs}`,
  );

  await tickDispatch();
  await tickReconcile();
  dispatchTimer = setInterval(() => {
    void tickDispatch();
  }, pollMs);
  reconcileTimer = setInterval(() => {
    void tickReconcile();
  }, reconcileMs);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      if (dispatchTimer) clearInterval(dispatchTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      console.log('[scheduler] stopped (lease acquisition halted)');
      resolve();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
