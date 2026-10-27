import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { scrubSecrets } from '../security/scrub.js';

const execFileAsync = promisify(execFile);

export type KiroMode = 'simulate' | 'real';

export function resolveKiroMode(env: NodeJS.ProcessEnv = process.env): KiroMode {
  const raw = (env.HYPERLOOP_KIRO_MODE ?? 'simulate').toLowerCase();
  if (raw === 'real' || raw === 'simulate') return raw;
  // Legacy: HYPERLOOP_KIRO_ENABLED=true without mode → real (still fails if flags unpinned)
  if (env.HYPERLOOP_KIRO_ENABLED === 'true') return 'real';
  return 'simulate';
}

export interface KiroExecOptions {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Binary name or absolute path; default `kiro`. */
  bin?: string;
  signal?: AbortSignal;
}

export interface KiroExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke Kiro CLI with execFile (no shell), timeout, SIGTERM forwarding, scrubbed IO.
 */
export async function execKiro(options: KiroExecOptions): Promise<KiroExecResult> {
  const bin = options.bin ?? 'kiro';
  const timeoutMs = options.timeoutMs ?? 600_000;
  let child: ChildProcess | undefined;

  const onAbort = () => {
    child?.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort);

  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        child = execFile(
          bin,
          options.args,
          {
            cwd: options.cwd,
            env: options.env ?? process.env,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            killSignal: 'SIGTERM',
          },
          (error, stdoutBuf, stderrBuf) => {
            const stdout = scrubSecrets(String(stdoutBuf ?? ''));
            const stderr = scrubSecrets(String(stderrBuf ?? ''));
            if (error) {
              const err = error as NodeJS.ErrnoException & { code?: number | string };
              const exitCode =
                typeof err.code === 'number'
                  ? err.code
                  : err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                    ? 1
                    : 1;
              const wrapped = new Error(
                `kiro failed (exit=${exitCode}): ${scrubSecrets(err.message)}`,
              ) as Error & { exitCode: number; stdout: string; stderr: string };
              wrapped.exitCode = exitCode;
              wrapped.stdout = stdout;
              wrapped.stderr = stderr;
              reject(wrapped);
              return;
            }
            resolve({ stdout, stderr });
          },
        );
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Parse JSON object from kiro stdout (last JSON object wins if logs precede it). */
export function parseKiroJsonStdout<T>(stdout: string): T {
  const scrubbed = scrubSecrets(stdout).trim();
  try {
    return JSON.parse(scrubbed) as T;
  } catch {
    const match = scrubbed.match(/\{[\s\S]*\}\s*$/);
    if (!match) {
      throw new Error('kiro stdout did not contain JSON object');
    }
    return JSON.parse(match[0]) as T;
  }
}

export interface KiroPlannerRequest {
  workflowId: string;
  sddCommitSha: string;
  promptSkill: string;
  inputArtifactUris: string[];
}

export interface KiroPlannerResponse {
  rawOutput: string;
}

/**
 * Planner entry: simulate → null (caller uses deterministic builder);
 * real → exec kiro with env-configured args.
 */
export async function invokeKiroPlanner(
  request: KiroPlannerRequest,
): Promise<KiroPlannerResponse | null> {
  const mode = resolveKiroMode();
  if (mode === 'simulate') {
    return null;
  }

  const args = resolveArgs('planner', { ...request });
  const result = await execKiro({ args, timeoutMs: Number(process.env.HYPERLOOP_KIRO_TIMEOUT_MS ?? 600_000) });
  return { rawOutput: result.stdout };
}

function resolveArgs(
  role: 'planner' | 'coding' | 'fix',
  request: Record<string, unknown>,
): string[] {
  const fromEnv = process.env.HYPERLOOP_KIRO_ARGS;
  if (fromEnv) {
    const parsed = JSON.parse(fromEnv) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
      throw new Error('HYPERLOOP_KIRO_ARGS must be a JSON string array');
    }
    return parsed;
  }
  // Placeholder shape until spike pins real flags — fail closed with clear message.
  throw new Error(
    `Kiro headless flags not pinned for role=${role} (workflow=${String(request.workflowId ?? '')}). ` +
      'Set HYPERLOOP_KIRO_ARGS or complete docs/spikes/kiro-cli-headless.md',
  );
}

// Keep execFileAsync import usable for thin wrappers / tests.
export { execFileAsync };
