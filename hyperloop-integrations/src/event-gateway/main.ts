import { SQSClient } from '@aws-sdk/client-sqs';
import { InMemoryEventBus } from '../events/event-bus.js';
import { SqsEventBus } from '../events/sqs-event-bus.js';
import { buildEventGateway } from './app.js';

function buildBus() {
  const mode = (process.env.ADAPTER_MODE ?? 'memory').toLowerCase();
  if (mode !== 'aws') {
    return new InMemoryEventBus();
  }
  const url = process.env.SQS_DEVSPEC_EVENTS_QUEUE_URL;
  if (!url) {
    throw new Error('ADAPTER_MODE=aws requires SQS_DEVSPEC_EVENTS_QUEUE_URL');
  }
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'ap-southeast-1',
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
  });
  return new SqsEventBus({
    client,
    queueUrls: {
      'devspec-events': url,
      ...(process.env.SQS_CI_EVENTS_QUEUE_URL
        ? { 'ci-events': process.env.SQS_CI_EVENTS_QUEUE_URL }
        : {}),
      ...(process.env.SQS_MR_EVENTS_QUEUE_URL
        ? { 'mr-events': process.env.SQS_MR_EVENTS_QUEUE_URL }
        : {}),
    },
  });
}

async function main(): Promise<void> {
  const bus = buildBus();
  const app = buildEventGateway({
    eventBus: bus,
    gitlabWebhookSecret: process.env.GITLAB_SDD_WEBHOOK_SECRET,
    jenkinsWebhookSecret: process.env.JENKINS_WEBHOOK_SECRET,
  });
  const port = Number(process.env.PORT ?? 8081);
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
