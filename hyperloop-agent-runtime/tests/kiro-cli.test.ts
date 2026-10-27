import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  execKiro,
  parseKiroJsonStdout,
  resolveKiroMode,
} from '../src/runner/kiro-cli.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-kiro.sh');
chmodSync(fixture, 0o755);

describe('kiro-cli', () => {
  it('defaults to simulate mode', () => {
    expect(resolveKiroMode({})).toBe('simulate');
    expect(resolveKiroMode({ HYPERLOOP_KIRO_MODE: 'real' })).toBe('real');
  });

  it('execFile fake kiro: scrubbed stdout + JSON parse', async () => {
    const result = await execKiro({ bin: fixture, args: [] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('ghp_SHOULD_BE_SCRUBBED');
    const parsed = parseKiroJsonStdout<{ summary: string; files: Record<string, string> }>(
      result.stdout,
    );
    expect(parsed.summary).toBe('fake-kiro-ok');
    expect(parsed.files['ok.txt']).toBe('yes');
  });

  it('forwards SIGTERM to hanging fake kiro', async () => {
    const controller = new AbortController();
    const pending = execKiro({
      bin: fixture,
      args: ['--hang'],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/kiro failed/);
  });
});
