/**
 * Child worker: race to reserve as many QUEUED tasks as possible via DynamoDB transactions.
 * Env: AWS_ENDPOINT_URL, DYNAMODB_TABLE, WORKER_ID, TASK_IDS (comma-separated)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Load compiled control-plane dist (built by the integration harness).
async function loadStore() {
  try {
    const mod = await import('../../hyperloop-control-plane/dist/adapters/dynamodb/dynamodb-scheduler-store.js');
    const { DEFAULT_SCHEDULER_CONFIG } = await import(
      '../../hyperloop-control-plane/dist/scheduler/config.js'
    );
    return { DynamoDbSchedulerStore: mod.DynamoDbSchedulerStore, DEFAULT_SCHEDULER_CONFIG };
  } catch {
    // Fall back to tsx-register style dynamic import of source via vitest parent.
    throw new Error('control-plane dist required; run npm run build in hyperloop-control-plane');
  }
}

const { DynamoDbSchedulerStore, DEFAULT_SCHEDULER_CONFIG } = await loadStore();
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:18000';
const table = process.env.DYNAMODB_TABLE ?? 'hyperloop-workflows-dev';
const taskIds = (process.env.TASK_IDS ?? '').split(',').filter(Boolean);
const workerId = process.env.WORKER_ID ?? '0';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'ap-southeast-1',
  endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const store = new DynamoDbSchedulerStore(table, {
  ...DEFAULT_SCHEDULER_CONFIG,
  globalMaxConcurrentJobs: Number(process.env.GLOBAL_MAX_CONCURRENT_JOBS ?? 100),
}, client);

await store.ensureCapacityInitialized();

let reserved = 0;
let conflicts = 0;
for (const taskId of taskIds) {
  try {
    await store.reserve(taskId);
    reserved += 1;
  } catch (error) {
    conflicts += 1;
    if (!String(error?.message ?? error).includes('capacity') &&
        !String(error?.message ?? error).includes('conflict') &&
        !String(error?.message ?? error).includes('not QUEUED')) {
      console.error(JSON.stringify({ workerId, error: String(error) }));
    }
  }
}

process.stdout.write(JSON.stringify({ workerId, reserved, conflicts }) + '\n');
