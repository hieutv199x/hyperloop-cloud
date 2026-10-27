import { startApi } from './main/api.js';
import { startScheduler } from './main/scheduler.js';

const command = process.argv[2] ?? 'api';

async function main(): Promise<void> {
  if (command === 'api') {
    await startApi();
    return;
  }
  if (command === 'scheduler') {
    await startScheduler();
    return;
  }

  console.error(`Unknown command: ${command}. Use: api | scheduler`);
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
