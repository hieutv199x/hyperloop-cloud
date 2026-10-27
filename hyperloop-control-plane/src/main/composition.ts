import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDbSchedulerStore } from '../adapters/dynamodb/dynamodb-scheduler-store.js';
import { DynamoDbWorkflowRepository } from '../adapters/dynamodb/dynamodb-workflow-repository.js';
import type { WorkflowRepository } from '../adapters/dynamodb/workflow-repository.js';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { KubernetesJobAdapter } from '../adapters/kubernetes/k8s-job-adapter.js';
import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import { InMemoryArtifactStore, type ArtifactStore } from '../adapters/s3/artifact-store.js';
import { S3ArtifactStore } from '../adapters/s3/s3-artifact-store.js';
import { SqsQueueBus } from '../adapters/sqs/sqs-queue-bus.js';
import type { AppConfig } from '../config.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulerConfig,
} from '../scheduler/config.js';
import type { SchedulerStorePort, SchedulerQueuePort } from '../scheduler/ports.js';
import { AtomicSchedulerStore } from '../scheduler/atomic-store.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';

export type AdapterMode = 'memory' | 'aws';

export interface ProductionAdapters {
  mode: AdapterMode;
  workflowRepository: WorkflowRepository;
  artifactStore: ArtifactStore;
  kubernetes: KubernetesJobPort;
  schedulerStore: SchedulerStorePort | AtomicSchedulerStore;
  queueBus: SchedulerQueuePort | InMemoryQueueBus;
  schedulerConfig: SchedulerConfig;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required config for ADAPTER_MODE=aws: ${name}`);
  }
  return value;
}

export function resolveAdapterMode(env: NodeJS.ProcessEnv = process.env): AdapterMode {
  const raw = (env.ADAPTER_MODE ?? 'memory').toLowerCase();
  if (raw === 'aws' || raw === 'memory') return raw;
  throw new Error(`Invalid ADAPTER_MODE=${raw}; expected memory|aws`);
}

/**
 * Composition root: unit tests keep memory; production requires ADAPTER_MODE=aws
 * and fails startup when required endpoints/URLs are missing.
 */
export function buildAdapters(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): ProductionAdapters {
  const mode = resolveAdapterMode(env);
  const schedulerConfig: SchedulerConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    globalMaxConcurrentJobs: config.GLOBAL_MAX_CONCURRENT_JOBS,
    pollIntervalSeconds: Number(env.SCHEDULER_POLL_INTERVAL_SECONDS ?? 5),
    reconciliationIntervalSeconds: Number(
      env.SCHEDULER_RECONCILE_INTERVAL_SECONDS ?? 30,
    ),
    queues: {
      planner: env.SQS_PLANNER_QUEUE_URL ?? DEFAULT_SCHEDULER_CONFIG.queues.planner,
      coding: env.SQS_CODING_QUEUE_URL ?? DEFAULT_SCHEDULER_CONFIG.queues.coding,
      fix: env.SQS_FIX_QUEUE_URL ?? DEFAULT_SCHEDULER_CONFIG.queues.fix,
    },
    kubernetes: {
      ...DEFAULT_SCHEDULER_CONFIG.kubernetes,
      namespace: config.AGENT_NAMESPACE,
      images: config.agentImages,
      imageAllowlist: [...config.agentImageAllowlist],
    },
  };

  if (mode === 'memory') {
    return {
      mode,
      workflowRepository: new InMemoryWorkflowRepository(),
      artifactStore: new InMemoryArtifactStore(),
      kubernetes: new FakeKubernetesAdapter(),
      schedulerStore: new AtomicSchedulerStore(schedulerConfig),
      queueBus: new InMemoryQueueBus(),
      schedulerConfig,
    };
  }

  const region = config.AWS_REGION;
  const endpoint = env.AWS_ENDPOINT_URL;
  const dynamo = new DynamoDBClient({
    region,
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
  });
  const sqs = new SQSClient({
    region,
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
  });
  const s3 = new S3Client({
    region,
    forcePathStyle: Boolean(endpoint),
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
  });

  const table = requireEnv('DYNAMODB_TABLE', config.DYNAMODB_TABLE);
  const bucket = requireEnv('ARTIFACTS_BUCKET', config.ARTIFACTS_BUCKET);
  const plannerUrl = requireEnv('SQS_PLANNER_QUEUE_URL', env.SQS_PLANNER_QUEUE_URL);
  const codingUrl = requireEnv('SQS_CODING_QUEUE_URL', env.SQS_CODING_QUEUE_URL);
  const fixUrl = requireEnv('SQS_FIX_QUEUE_URL', env.SQS_FIX_QUEUE_URL);

  const schedulerStore = new DynamoDbSchedulerStore(table, schedulerConfig, dynamo);
  const queueBus = new SqsQueueBus({
    client: sqs,
    queueUrls: { planner: plannerUrl, coding: codingUrl, fix: fixUrl },
  });

  return {
    mode,
    workflowRepository: new DynamoDbWorkflowRepository(table, dynamo),
    artifactStore: new S3ArtifactStore(s3, bucket),
    kubernetes: new KubernetesJobAdapter(),
    schedulerStore,
    queueBus,
    schedulerConfig,
  };
}
