import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoDbSchedulerStore } from '../../../hyperloop-control-plane/src/adapters/dynamodb/dynamodb-scheduler-store.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../../../hyperloop-control-plane/src/scheduler/config.js';
import { PriorityPolicy } from '../../../hyperloop-control-plane/src/scheduler/priority-policy.js';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:18000';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** Fresh table per run so leftover QUEUED rows from prior suites don't pollute counts. */
const table =
  process.env.DYNAMODB_TABLE ?? `hyperloop-workflows-cap-${Date.now()}`;

async function dynamoReady(): Promise<boolean> {
  try {
    const client = new DynamoDBClient({
      region: 'ap-southeast-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const { ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
    await client.send(new ListTablesCommand({}));
    return true;
  } catch {
    return false;
  }
}

describe('P7 DynamoDB capacity (150 intents / 3 workers)', () => {
  const ready = { value: false };

  beforeAll(async () => {
    ready.value = await dynamoReady();
    if (!ready.value) return;
    const { spawnSync } = await import('node:child_process');
    const ensure = spawnSync(
      process.execPath,
      [join(root, 'scripts/ensure-dynamodb-table.mjs')],
      {
        env: {
          ...process.env,
          AWS_ENDPOINT_URL: endpoint,
          DYNAMODB_TABLE: table,
        },
        encoding: 'utf8',
      },
    );
    if (ensure.status !== 0) {
      throw new Error(`ensure table failed: ${ensure.stderr || ensure.stdout}`);
    }
    // Build control-plane so worker can import dist
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: join(root, '../hyperloop-control-plane'),
      encoding: 'utf8',
    });
    if (build.status !== 0) {
      throw new Error(`control-plane build failed: ${build.stderr || build.stdout}`);
    }
  }, 120_000);

  it('reserves at most 100 of 150 across 3 processes; 50 stay QUEUED', async () => {
    if (!ready.value) {
      console.warn('SKIP: DynamoDB Local not reachable at', endpoint);
      return;
    }

    const client = new DynamoDBClient({
      region: 'ap-southeast-1',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const config = {
      ...DEFAULT_SCHEDULER_CONFIG,
      globalMaxConcurrentJobs: 100,
    };
    const store = new DynamoDbSchedulerStore(table, config, client);
    await store.ensureCapacityInitialized();
    await store.setCapacityLimit(100);
    await store.resetCapacityUsed();

    const policy = new PriorityPolicy(config);
    const taskIds: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const taskId = `task-cap-${Date.now()}-${i}`;
      taskIds.push(taskId);
      await store.enqueue(
        {
          taskId,
          workflowId: 'WF#CAP#1',
          stage: 'planner',
        },
        policy,
      );
    }

    // All three processes race the same 150 task IDs (cross-process TransactWrite).
    const workerScript = join(root, 'scripts/scheduler-worker.mjs');
    const allIds = taskIds.join(',');

    const runWorker = (workerId: string) =>
      new Promise<{ workerId: string; reserved: number; conflicts: number }>((resolve, reject) => {
        const child = spawn(process.execPath, [workerScript], {
          env: {
            ...process.env,
            AWS_ENDPOINT_URL: endpoint,
            DYNAMODB_TABLE: table,
            GLOBAL_MAX_CONCURRENT_JOBS: '100',
            WORKER_ID: workerId,
            TASK_IDS: allIds,
          },
          cwd: root,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += String(d);
        });
        child.stderr.on('data', (d) => {
          stderr += String(d);
        });
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`worker ${workerId} exit ${code}: ${stderr || stdout}`));
            return;
          }
          const line = stdout.trim().split('\n').at(-1) ?? '{}';
          resolve(JSON.parse(line) as { workerId: string; reserved: number; conflicts: number });
        });
      });

    const results = await Promise.all([runWorker('0'), runWorker('1'), runWorker('2')]);

    const totalReserved = results.reduce((n, r) => n + r.reserved, 0);
    expect(totalReserved).toBe(100);
    expect(await store.activeReservationCount()).toBe(100);
    expect(await store.countByStatus('QUEUED')).toBe(50);
  }, 180_000);
});
