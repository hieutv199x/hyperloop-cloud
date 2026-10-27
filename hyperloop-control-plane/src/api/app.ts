import Fastify from 'fastify';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { ApprovalService } from '../application/approval-service.js';
import {
  ApprovalError,
  WorkflowOrchestrator,
} from '../application/workflow-orchestrator.js';
import { loadConfig } from '../config.js';
import type { DevSpecDocument } from '../domain/types.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../scheduler/config.js';
import { JobQueueScheduler } from '../scheduler/job-queue-scheduler.js';
import { ApproverPolicy } from '../security/approver-policy.js';
import { InMemoryQueueBus } from '../workers/in-memory-queue.js';

export interface AppOptions {
  orchestrator?: WorkflowOrchestrator;
  scheduler?: JobQueueScheduler;
  approvalService?: ApprovalService;
  webhookSecret?: string;
  approverAllowlist?: string[];
}

export function buildApp(options: AppOptions = {}) {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  });

  const kubernetes = new FakeKubernetesAdapter();
  const queueBus = new InMemoryQueueBus();
  const scheduler =
    options.scheduler ??
    new JobQueueScheduler(
      {
        ...DEFAULT_SCHEDULER_CONFIG,
        globalMaxConcurrentJobs: config.GLOBAL_MAX_CONCURRENT_JOBS,
        kubernetes: {
          ...DEFAULT_SCHEDULER_CONFIG.kubernetes,
          namespace: config.AGENT_NAMESPACE,
        },
      },
      kubernetes,
      { queueBus },
    );

  const allowlist =
    options.approverAllowlist ??
    (process.env.APPROVER_ALLOWLIST
      ? process.env.APPROVER_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
      : ['*']);

  const orchestrator =
    options.orchestrator ??
    new WorkflowOrchestrator({
      repository: new InMemoryWorkflowRepository(),
      kubernetes,
      agentNamespace: config.AGENT_NAMESPACE,
      agentImage: 'nexus.example/hyperloop/kiro-agent:0.1.0',
      webhookSecret: options.webhookSecret ?? process.env.GITLAB_SDD_WEBHOOK_SECRET,
      approverPolicy: ApproverPolicy.fromAllowlist(allowlist),
      onApprovalsInvalidated: (workflowId) => {
        scheduler.store.clearSpecApproval(workflowId);
      },
    });

  const approvalService =
    options.approvalService ?? new ApprovalService(orchestrator, scheduler);

  const app = Fastify({ logger: config.NODE_ENV !== 'test' });

  app.get('/health', async () => ({ status: 'ok', service: 'hyperloop-control-plane' }));

  app.post('/webhooks/gitlab/sdd', async (request, reply) => {
    const headerSecret =
      (request.headers['x-gitlab-token'] as string | undefined) ??
      (request.headers['x-hyperloop-webhook-secret'] as string | undefined);

    const body = request.body as {
      eventId?: string;
      occurredAt?: string;
      project?: string;
      userStory?: string;
      revision?: number;
      sddCommitSha?: string;
      sddPath?: string;
      devSpec?: DevSpecDocument;
    };

    if (
      !body.eventId ||
      !body.occurredAt ||
      !body.project ||
      !body.userStory ||
      !body.revision ||
      !body.sddCommitSha ||
      !body.sddPath ||
      !body.devSpec
    ) {
      return reply.code(400).send({ error: 'Invalid SDD webhook payload' });
    }

    const result = await orchestrator.submitDevSpec({
      eventId: body.eventId,
      occurredAt: body.occurredAt,
      project: body.project,
      userStory: body.userStory,
      revision: body.revision,
      sddCommitSha: body.sddCommitSha,
      sddPath: body.sddPath,
      devSpec: body.devSpec,
      webhookSecret: headerSecret,
    });

    if (result.outcome === 'rejected') {
      return reply.code(result.statusCode).send({ error: result.reason });
    }

    return reply.code(result.outcome === 'created' ? 202 : 200).send({
      outcome: result.outcome,
      workflowId: result.workflow.workflowId,
      status: result.workflow.status,
      desiredJobs: result.workflow.desiredJobs,
    });
  });

  app.post('/webhooks/jenkins/ci', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', milestone: 'M5' });
  });

  app.post('/webhooks/gitlab/mr', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', milestone: 'M4' });
  });

  app.get('/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await orchestrator.getWorkflow(id);
    if (!workflow) {
      return reply.code(404).send({ error: 'Workflow not found' });
    }
    return workflow;
  });

  app.get('/workflows/:id/timeline', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await orchestrator.getWorkflow(id);
    if (!workflow) {
      return reply.code(404).send({ error: 'Workflow not found' });
    }
    return { workflowId: id, timeline: workflow.timeline };
  });

  app.get('/workflows/:id/tasks', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tasks = [...scheduler.store.tasks.values()].filter((t) => t.workflowId === id);
    return { workflowId: id, tasks };
  });

  app.post('/workflows/:id/complete-planner', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      specHash?: string;
      implementationSpecUri?: string;
      planServices?: WorkflowRecordPlanServices;
    };
    if (!body.specHash || !body.implementationSpecUri) {
      return reply.code(400).send({ error: 'specHash and implementationSpecUri required' });
    }
    try {
      const workflow = await orchestrator.completePlanner(id, {
        specHash: body.specHash,
        implementationSpecUri: body.implementationSpecUri,
        planServices: body.planServices,
      });
      return workflow;
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'Failed to complete planner',
      });
    }
  });

  app.post('/workflows/:id/approve-spec', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      approvedSpecHash?: string;
      approvedSddCommitSha?: string;
      decision?: 'APPROVED' | 'SPEC_CHANGES_REQUESTED' | 'REJECTED';
      expectedVersion?: number;
      approver?: { entraId?: string; displayName?: string; email?: string };
      comment?: string;
    };

    // Server-side identity: prefer gateway-asserted header over body (Teams must set this).
    const headerEntra = request.headers['x-hyperloop-entra-id'] as string | undefined;
    const headerName = request.headers['x-hyperloop-entra-name'] as string | undefined;

    const entraId = headerEntra ?? body.approver?.entraId;
    const displayName = headerName ?? body.approver?.displayName;

    if (
      !body.approvedSpecHash ||
      !body.approvedSddCommitSha ||
      !body.decision ||
      body.expectedVersion == null ||
      !entraId ||
      !displayName
    ) {
      return reply.code(400).send({ error: 'Invalid approval payload' });
    }

    try {
      const result = await approvalService.approve({
        workflowId: id,
        approvedSpecHash: body.approvedSpecHash,
        approvedSddCommitSha: body.approvedSddCommitSha,
        decision: body.decision,
        expectedVersion: body.expectedVersion,
        approver: {
          entraId,
          displayName,
          email: body.approver?.email,
        },
        comment: body.comment,
      });
      return {
        workflowId: result.workflow.workflowId,
        status: result.workflow.status,
        version: result.workflow.version,
        codingTasksEnqueued: result.codingTasksEnqueued,
        approvals: result.workflow.approvals,
      };
    } catch (error) {
      if (error instanceof ApprovalError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'Approval failed',
      });
    }
  });

  app.post('/workflows/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const workflow = await orchestrator.cancel(id);
      return workflow;
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'Cancel failed',
      });
    }
  });

  app.post('/workflows/:id/resume', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const workflow = await orchestrator.resume(id);
      return workflow;
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'Resume failed',
      });
    }
  });

  app.get('/scheduler/capacity', async (_request, reply) => {
    scheduler.refreshMetrics();
    return reply.send(scheduler.store.capacity.snapshot(scheduler.store.activeByStage()));
  });

  app.get('/scheduler/queues', async (_request, reply) => {
    return reply.send({
      depths: queueBus.depths(),
      durableQueued: scheduler.store.countByStatus('QUEUED'),
      metrics: scheduler.metrics.snapshot(),
    });
  });

  return app;
}

type WorkflowRecordPlanServices = Array<{
  repository: string;
  workingBranch: string;
  targetBranch: string;
  dependsOn: string[];
}>;
