import { buildApp } from './bot/app.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8090);
  const app = buildApp();
  await app.listen({ port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
