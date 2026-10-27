import {
  InMemoryEventBus,
  SqsEventBus,
  type EventBus,
} from '@hyperloop/integrations';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ApprovalService } from '../application/approval-service.js';
import { CiDecisionService } from '../application/ci-decision-service.js';
import { ExecutionFenceService } from '../application/execution-fence-service.js';
import { WorkflowOrchestrator } from '../application/workflow-orchestrator.js';
import type { AppConfig } from '../config.js';
import { ApproverPolicy } from '../security/approver-policy.js';
import { AtomicSchedulerStore } from '../scheduler/atomic-store.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';
import { EventConsumer } from '../workers/event-consumer.js';
import { buildAdapters, type ProductionAdapters } from './composition.js';

export interface ControlPlaneRuntime {
  adapters: ProductionAdapters;
  orchestrator: WorkflowOrchestrator;
  scheduler: JobQueueScheduler;
  approvalService: ApprovalService;
  fenceService: ExecutionFenceService;
  ciDecision: CiDecisionService;
  eventBus: EventBus;
  eventConsumer: EventConsumer;
  queueBus: InMemoryQueueBus;
}

function buildEventBus(config: AppConfig, env: NodeJS.ProcessEnv): EventBus {
  const mode = (env.ADAPTER_MODE ?? 'memory').toLowerCase();
  if (mode !== 'aws') {
    return new InMemoryEventBus();
  }
  const url = env.SQS_DEVSPEC_EVENTS_QUEUE_URL ?? config.SQS_DEVSPEC_EVENTS_QUEUE_URL;
  if (!url) {
    throw new Error('ADAPTER_MODE=aws requires SQS_DEVSPEC_EVENTS_QUEUE_URL');
  }
  const endpoint = env.AWS_ENDPOINT_URL ?? config.AWS_ENDPOINT_URL;
  const client = new SQSClient({
    region: config.AWS_REGION,
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
  return new SqsEventBus({
    client,
    queueUrls: {
      'devspec-events': url,
      ...(env.SQS_CI_EVENTS_QUEUE_URL
        ? { 'ci-events': env.SQS_CI_EVENTS_QUEUE_URL }
        : {}),
      ...(env.SQS_MR_EVENTS_QUEUE_URL
        ? { 'mr-events': env.SQS_MR_EVENTS_QUEUE_URL }
        : {}),
    },
  });
}

/**
 * Full Control Plane wiring for api + scheduler processes.
 */
export function buildRuntime(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneRuntime {
  const adapters = buildAdapters(config, env);
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

  const allowlist = env.APPROVER_ALLOWLIST
    ? env.APPROVER_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
    : ['*'];

  const orchestrator = new WorkflowOrchestrator({
    repository: adapters.workflowRepository,
    kubernetes: adapters.kubernetes,
    agentNamespace: config.AGENT_NAMESPACE,
    agentImages: config.agentImages,
    agentImageAllowlist: config.agentImageAllowlist,
    approverPolicy: ApproverPolicy.fromAllowlist(allowlist),
    onApprovalsInvalidated: (workflowId) => {
      scheduler.store.clearSpecApproval(workflowId);
    },
  });

  const approvalService = new ApprovalService(orchestrator, scheduler);
  const fenceService = new ExecutionFenceService(adapters.workflowRepository);
  const ciDecision = new CiDecisionService(orchestrator, scheduler);
  const eventBus = buildEventBus(config, env);
  const eventConsumer = new EventConsumer({
    eventBus,
    orchestrator,
    ciDecision,
  });

  return {
    adapters,
    orchestrator,
    scheduler,
    approvalService,
    fenceService,
    ciDecision,
    eventBus,
    eventConsumer,
    queueBus,
  };
}
