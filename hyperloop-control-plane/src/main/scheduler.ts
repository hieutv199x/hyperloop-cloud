import { loadConfig } from '../config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { AtomicSchedulerStore } from '../scheduler/atomic-store.js';
import { DynamoDbSchedulerStore } from '../adapters/dynamodb/dynamodb-scheduler-store.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';
import { buildAdapters } from './composition.js';

/**
 * Control Plane Scheduler process (v1.3): wake-up poll + reconcile loop.
 * Same image as API; selected via `node dist/index.js scheduler`.
 * Returns when SIGTERM/SIGINT is received (after draining timers).
 */
export async function startScheduler(): Promise<void> {
  const config = loadConfig();
  const adapters = buildAdapters(config);

  if (adapters.schedulerStore instanceof DynamoDbSchedulerStore) {
    await adapters.schedulerStore.ensureCapacityInitialized();
    console.log('[scheduler] DynamoDB capacity item initialized');
  }

  // JobQueueScheduler still drives the in-memory AtomicSchedulerStore for the
  // dispatch/reconcile loop. Cross-process admission is proven by DynamoDB
  // TransactWrite (e2e integration + DynamoDbSchedulerStore). Full async port
  // swap of JobQueueScheduler is a follow-up when reconciler reads are async.
  const store =
    adapters.schedulerStore instanceof AtomicSchedulerStore
      ? adapters.schedulerStore
      : new AtomicSchedulerStore(adapters.schedulerConfig);
  const queueBus =
    adapters.queueBus instanceof InMemoryQueueBus
      ? adapters.queueBus
      : new InMemoryQueueBus();

  const scheduler = new JobQueueScheduler(
    adapters.schedulerConfig,
    adapters.kubernetes,
    { store, queueBus },
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
    `[scheduler] started mode=${adapters.mode} poll=${scheduler.config.pollIntervalSeconds}s reconcile=${scheduler.config.reconciliationIntervalSeconds}s limit=${scheduler.config.globalMaxConcurrentJobs}`,
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
