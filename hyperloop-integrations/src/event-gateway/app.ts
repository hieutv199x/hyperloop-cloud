import Fastify from 'fastify';
import { verifySharedSecret } from '../common/auth.js';
import { DevSpecChangeDetector } from '../gitlab/dev-spec-change-detector.js';
import { JenkinsCallbackParser } from '../jenkins/callback.js';
import {
  DEVSPEC_EVENTS_QUEUE,
  type EventBus,
  type NormalizedWorkflowEvent,
} from '../events/event-bus.js';
import {
  normalizeCiResult,
  normalizeMrMerged,
  normalizeSddSubmitted,
} from './normalize.js';

export interface EventGatewayOptions {
  eventBus: EventBus;
  gitlabWebhookSecret?: string;
  jenkinsWebhookSecret?: string;
  projectAllowlist?: ReadonlySet<string>;
  detector?: DevSpecChangeDetector;
  /** Durable delivery ids already seen (optional shared store). */
  seenDeliveries?: Set<string>;
}

/**
 * Event Gateway — authenticate, normalize, publish. Never clones repos or runs agents.
 */
export function buildEventGateway(options: EventGatewayOptions) {
  const detector = options.detector ?? new DevSpecChangeDetector();
  const seen = options.seenDeliveries ?? new Set<string>();
  const allowlist = options.projectAllowlist ?? new Set(['*']);

  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok', service: 'hyperloop-event-gateway' }));

  app.post('/webhooks/gitlab/sdd', async (request, reply) => {
    const token =
      (request.headers['x-gitlab-token'] as string | undefined) ??
      (request.headers['x-hyperloop-webhook-secret'] as string | undefined);
    if (
      options.gitlabWebhookSecret &&
      !verifySharedSecret(token, options.gitlabWebhookSecret)
    ) {
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    const body = request.body as {
      eventId?: string;
      occurredAt?: string;
      project?: string;
      userStory?: string;
      revision?: number;
      sddCommitSha?: string;
      sddPath?: string;
      sddProject?: string;
      changedPaths?: string[];
      devSpec?: unknown;
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

    if (
      !allowlist.has('*') &&
      !allowlist.has(body.project) &&
      !(body.sddProject && allowlist.has(body.sddProject))
    ) {
      return reply.code(403).send({ error: 'Project not allowlisted' });
    }

    if (seen.has(body.eventId)) {
      return reply.code(200).send({ outcome: 'duplicate', eventId: body.eventId });
    }

    if (!/^[a-f0-9]{40}$/i.test(body.sddCommitSha)) {
      return reply.code(400).send({ error: 'Invalid sddCommitSha' });
    }

    const changedPaths = body.changedPaths ?? [body.sddPath];
    const relevant = changedPaths.some((path) =>
      detector.isRelevantPath(path, body.sddPath),
    );
    if (!relevant) {
      // Ack unrelated pushes so GitLab does not retry; do not publish.
      seen.add(body.eventId);
      return reply.code(200).send({
        outcome: 'ignored',
        reason: 'No relevant SDD planning paths changed',
      });
    }

    const event = normalizeSddSubmitted({
      eventId: body.eventId,
      occurredAt: body.occurredAt,
      project: body.project,
      userStory: body.userStory,
      revision: body.revision,
      sddCommitSha: body.sddCommitSha,
      sddPath: body.sddPath,
      sddProject: body.sddProject,
      changedPaths,
      devSpec: body.devSpec,
    });

    try {
      await options.eventBus.publish(DEVSPEC_EVENTS_QUEUE, event);
    } catch {
      // Do not mark seen — GitLab/Jenkins should retry.
      return reply.code(503).send({ error: 'Event publish failed; retry delivery' });
    }

    seen.add(body.eventId);
    return reply.code(202).send({
      outcome: 'accepted',
      eventId: event.eventId,
      workflowId: event.workflowId,
      eventType: event.eventType,
    });
  });

  app.post('/webhooks/jenkins/ci', async (request, reply) => {
    const token =
      (request.headers['x-jenkins-token'] as string | undefined) ??
      (request.headers['x-hyperloop-webhook-secret'] as string | undefined);
    if (
      options.jenkinsWebhookSecret &&
      !verifySharedSecret(token, options.jenkinsWebhookSecret)
    ) {
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    const body = request.body as {
      eventId?: string;
      occurredAt?: string;
      workflowId?: string;
      repository?: string;
      mrIid?: number;
      commitSha?: string;
      pipelineId?: string;
      status?: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE';
      buildId?: string;
      gateFailures?: Array<{
        gate: string;
        classification: 'fixable' | 'non_fixable';
        message: string;
      }>;
      reportUri?: string;
      logUri?: string;
    };

    if (!body.eventId || !body.occurredAt) {
      return reply.code(400).send({ error: 'Invalid Jenkins CI payload' });
    }

    let parsed;
    try {
      parsed = new JenkinsCallbackParser().parse(body);
    } catch {
      return reply.code(400).send({ error: 'Invalid Jenkins CI payload' });
    }

    if (seen.has(body.eventId)) {
      return reply.code(200).send({ outcome: 'duplicate' });
    }

    const event = normalizeCiResult({
      eventId: body.eventId,
      occurredAt: body.occurredAt,
      workflowId: parsed.workflowId,
      repository: parsed.repository,
      mrIid: parsed.mrIid,
      commitSha: parsed.commitSha,
      pipelineId: parsed.pipelineId,
      status: parsed.status,
      buildId: parsed.buildId,
      gateFailures: parsed.gateFailures,
      reportUri: parsed.reportUri,
      logUri: parsed.logUri,
    });

    try {
      await options.eventBus.publish(DEVSPEC_EVENTS_QUEUE, event);
    } catch {
      return reply.code(503).send({ error: 'Event publish failed; retry delivery' });
    }
    seen.add(body.eventId);
    return reply.code(202).send({ outcome: 'accepted', eventType: event.eventType });
  });

  app.post('/webhooks/gitlab/mr', async (request, reply) => {
    const token =
      (request.headers['x-gitlab-token'] as string | undefined) ??
      (request.headers['x-hyperloop-webhook-secret'] as string | undefined);
    if (
      options.gitlabWebhookSecret &&
      !verifySharedSecret(token, options.gitlabWebhookSecret)
    ) {
      return reply.code(401).send({ error: 'Unauthorized webhook' });
    }

    const body = request.body as {
      eventId?: string;
      occurredAt?: string;
      workflowId?: string;
      repository?: string;
      mrIid?: number;
      mergeCommitSha?: string;
      action?: string;
    };

    if (
      !body.eventId ||
      !body.occurredAt ||
      !body.workflowId ||
      !body.repository ||
      body.mrIid == null ||
      !body.mergeCommitSha
    ) {
      return reply.code(400).send({ error: 'Invalid MR webhook payload' });
    }

    if (body.action && body.action !== 'merge') {
      return reply.code(200).send({ outcome: 'ignored', reason: 'Not a merge action' });
    }

    if (seen.has(body.eventId)) {
      return reply.code(200).send({ outcome: 'duplicate' });
    }

    const event: NormalizedWorkflowEvent = normalizeMrMerged({
      eventId: body.eventId,
      occurredAt: body.occurredAt,
      workflowId: body.workflowId,
      repository: body.repository,
      mrIid: body.mrIid,
      mergeCommitSha: body.mergeCommitSha,
    });

    try {
      await options.eventBus.publish(DEVSPEC_EVENTS_QUEUE, event);
    } catch {
      return reply.code(503).send({ error: 'Event publish failed; retry delivery' });
    }
    seen.add(body.eventId);
    return reply.code(202).send({ outcome: 'accepted', eventType: event.eventType });
  });

  return app;
}
