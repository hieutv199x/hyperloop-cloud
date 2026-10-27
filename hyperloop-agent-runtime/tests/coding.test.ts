import { describe, expect, it } from 'vitest';
import { InMemoryGitLabClient } from '@hyperloop/integrations';
import { InMemoryArtifactStore } from '../src/artifacts/memory-store.js';
import { runCoding } from '../src/roles/coding/index.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function gitlab() {
  return new InMemoryGitLabClient(new Set(['coc-ewallet-service']), [
    { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
  ]);
}

describe('coding M4', () => {
  it('checks out working branch, pushes commit, opens MR to release branch', async () => {
    const gl = gitlab();
    const store = new InMemoryArtifactStore();
    const result = await runCoding({
      stage: 'coding',
      jobId: 'job-coding-1',
      workflowId: 'WF#PAY-1234#1',
      repository: 'coc-ewallet-service',
      workingBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      approvedSpecHash: SPEC,
      expectedApprovedSpecHash: SPEC,
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: store,
      gitlab: gl,
    });

    expect(result.exitStatus).toBe('SUCCEEDED');
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.mrIid).toBe(1);
    expect(result.branch).toBe('feature/PAY-1234');
    expect(gl.mergeRequests[0]?.targetBranch).toBe('release/2.5.0');
    expect(gl.mergeRequests[0]?.sourceBranch).toBe('feature/PAY-1234');
  });

  it('rejects spec hash mismatch and does not push to release', async () => {
    const gl = gitlab();
    const result = await runCoding({
      stage: 'coding',
      jobId: 'job-coding-2',
      workflowId: 'WF#PAY-1234#1',
      repository: 'coc-ewallet-service',
      workingBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      approvedSpecHash: SPEC,
      expectedApprovedSpecHash:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: new InMemoryArtifactStore(),
      gitlab: gl,
    });
    expect(result.exitStatus).toBe('FAILED');
    expect(result.errorCode).toBe('HL_CODING_SPEC_HASH_MISMATCH');
    expect(gl.commits).toHaveLength(0);
  });

  it('after crash-after-push, retry reconciles without duplicate commit or MR', async () => {
    const gl = gitlab();
    const store = new InMemoryArtifactStore();
    const base = {
      stage: 'coding' as const,
      jobId: 'job-coding-3',
      workflowId: 'WF#PAY-1234#1',
      repository: 'coc-ewallet-service',
      workingBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      approvedSpecHash: SPEC,
      expectedApprovedSpecHash: SPEC,
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: store,
      gitlab: gl,
    };

    const crashed = await runCoding({ ...base, simulateCrashAfterPush: true });
    expect(crashed.exitStatus).toBe('FAILED');
    expect(crashed.errorCode).toBe('HL_CODING_CRASH_AFTER_PUSH');
    expect(gl.commits).toHaveLength(1);
    expect(gl.mergeRequests).toHaveLength(0);

    const retry = await runCoding(base);
    expect(retry.exitStatus).toBe('SUCCEEDED');
    expect(retry.mrIid).toBe(1);
    expect(gl.mergeRequests).toHaveLength(1);
    expect(gl.commits).toHaveLength(1);
  });
});
