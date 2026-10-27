import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import type { ControlPlaneRuntime } from './runtime.js';

export async function startApi(): Promise<void> {
  const config = loadConfig();
  const app = buildApp();
  const runtime = (app as FastifyInstance & { hyperloopRuntime?: ControlPlaneRuntime })
    .hyperloopRuntime;

  const pollMs = Number(process.env.EVENT_CONSUMER_POLL_MS ?? 2000);
  let stopping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  if (runtime) {
    const tick = async () => {
      if (stopping) return;
      try {
        await runtime.eventConsumer.pollOnce(10);
      } catch (error) {
        console.error('[api] eventConsumer.pollOnce failed', error);
      }
    };
    await tick();
    pollTimer = setInterval(() => {
      void tick();
    }, pollMs);
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(
    `[api] started port=${config.PORT} eventPoll=${runtime ? `${pollMs}ms` : 'off'}`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      await app.close();
      console.log('[api] stopped');
      resolve();
    };
    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
  });
}
