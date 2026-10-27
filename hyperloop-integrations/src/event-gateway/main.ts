import { InMemoryEventBus } from '../events/event-bus.js';
import { buildEventGateway } from './app.js';

async function main(): Promise<void> {
  const bus = new InMemoryEventBus();
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
