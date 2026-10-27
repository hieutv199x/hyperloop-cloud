import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';

export async function startApi(): Promise<void> {
  const config = loadConfig();
  const app = buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}
