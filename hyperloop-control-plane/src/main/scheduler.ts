import { loadConfig } from '../config.js';
import { DynamoDbSchedulerStore } from '../adapters/dynamodb/dynamodb-scheduler-store.js';
import { buildRuntime } from './runtime.js';

/**
 * Control Plane Scheduler process (v1.3): wake-up poll + reconcile + terminal finalize.
 */
export async function startScheduler(): Promise<void> {
  const config = loadConfig();
  const runtime = buildRuntime(config);

  if (runtime.adapters.schedulerStore instanceof DynamoDbSchedulerStore) {
    await runtime.adapters.schedulerStore.ensureCapacityInitialized();
    console.log('[scheduler] DynamoDB capacity item initialized');
  }

  const { scheduler } = runtime;

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
      await scheduler.reconciler.finalizeTerminalJobs();
      scheduler.refreshMetrics();
    } catch (error) {
      console.error('[scheduler] reconcile/finalize failed', error);
    }
  };

  console.log(
    `[scheduler] started mode=${runtime.adapters.mode} poll=${scheduler.config.pollIntervalSeconds}s reconcile=${scheduler.config.reconciliationIntervalSeconds}s limit=${scheduler.config.globalMaxConcurrentJobs}`,
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
