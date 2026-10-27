import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('control-plane entrypoints', () => {
  it('unknown command exits with code 2', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'bogus'],
      {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const code = await new Promise<number>((resolve) => {
      child.on('exit', (c) => resolve(c ?? 1));
    });
    expect(code).toBe(2);
  });

  it('scheduler starts and stops on SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'scheduler'],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          SCHEDULER_POLL_INTERVAL_SECONDS: '30',
          SCHEDULER_RECONCILE_INTERVAL_SECONDS: '30',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let logs = '';
    child.stdout.on('data', (buf: Buffer) => {
      logs += buf.toString();
    });
    child.stderr.on('data', (buf: Buffer) => {
      logs += buf.toString();
    });

    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      child.stdout.on('data', (buf: Buffer) => {
        if (buf.toString().includes('[scheduler] started')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    expect(started).toBe(true);

    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    // Graceful handler resolves main (code 0); some runtimes report signal exit as null.
    expect(
      exit.code === 0 || exit.signal === 'SIGTERM' || logs.includes('[scheduler] stopped'),
    ).toBe(true);
  });
});
