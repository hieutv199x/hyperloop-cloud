import { describe, expect, it } from 'vitest';
import { buildEventGateway } from '../src/event-gateway/app.js';
import { DEVSPEC_EVENTS_QUEUE, InMemoryEventBus } from '../src/events/event-bus.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const sddPayload = {
  eventId: 'evt-gw-1',
  occurredAt: '2026-10-27T12:00:00.000Z',
  project: 'payment-sdd',
  userStory: 'PAY-8000',
  revision: 1,
  sddCommitSha: SHA,
  sddPath: '04-development/PAY-8000/dev-spec.yaml',
  changedPaths: ['04-development/PAY-8000/dev-spec.yaml'],
  devSpec: {
    apiVersion: 'hyperloop.dev/v1',
    kind: 'DevelopmentSpec',
    metadata: { project: 'payment-sdd', userStory: 'PAY-8000', revision: 1 },
    spec: {
      status: 'submitted',
      requirements: ['r.md'],
      designs: ['d.md'],
      acceptanceCriteria: ['ac.md'],
      targets: [
        {
          repository: 'group/wallet-service',
          workingBranch: 'feature/PAY-8000',
          targetBranch: 'release/2.5.0',
        },
      ],
      execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
    },
  },
};

describe('Event Gateway', () => {
  it('rejects bad token with 401', async () => {
    const bus = new InMemoryEventBus();
    const app = buildEventGateway({
      eventBus: bus,
      gitlabWebhookSecret: 'secret',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'wrong' },
      payload: sddPayload,
    });
    expect(res.statusCode).toBe(401);
    expect(bus.published).toHaveLength(0);
  });

  it('publishes SDD_REVISION_SUBMITTED once; duplicate delivery does not republish', async () => {
    const bus = new InMemoryEventBus();
    const app = buildEventGateway({
      eventBus: bus,
      gitlabWebhookSecret: 'secret',
    });
    const headers = { 'x-gitlab-token': 'secret' };
    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers,
      payload: sddPayload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers,
      payload: sddPayload,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      outcome: 'accepted',
      eventType: 'SDD_REVISION_SUBMITTED',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ outcome: 'duplicate' });
    expect(bus.published).toHaveLength(1);
    expect(bus.depth(DEVSPEC_EVENTS_QUEUE)).toBe(1);
  });

  it('ignores unrelated path pushes without publishing', async () => {
    const bus = new InMemoryEventBus();
    const app = buildEventGateway({ eventBus: bus, gitlabWebhookSecret: 'secret' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'secret' },
      payload: {
        ...sddPayload,
        eventId: 'evt-unrelated',
        changedPaths: ['README.md'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'ignored' });
    expect(bus.published).toHaveLength(0);
  });

  it('returns 503 when publish fails so delivery can retry', async () => {
    const bus = new InMemoryEventBus();
    bus.failNextPublish = true;
    const app = buildEventGateway({ eventBus: bus, gitlabWebhookSecret: 'secret' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'secret' },
      payload: { ...sddPayload, eventId: 'evt-retry' },
    });
    expect(res.statusCode).toBe(503);
    const retry = await app.inject({
      method: 'POST',
      url: '/webhooks/gitlab/sdd',
      headers: { 'x-gitlab-token': 'secret' },
      payload: { ...sddPayload, eventId: 'evt-retry' },
    });
    expect(retry.statusCode).toBe(202);
    expect(bus.published).toHaveLength(1);
  });
});
