import { describe, expect, it, vi } from 'vitest';
import { InMemoryArtifactStore } from '../src/artifacts/memory-store.js';
import { runFix } from '../src/roles/fix/index.js';
import type { CodingGitLabPort } from '../src/roles/coding/index.js';
import { workflowMarker } from '../src/roles/coding/index.js';

const FAILED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEXT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function gitlabStub(opts: {
  headSha: string;
  mrIid?: number;
  createMr?: ReturnType<typeof vi.fn>;
}): CodingGitLabPort & { pushCount: number; createMrCalls: number } {
  let pushCount = 0;
  let createMrCalls = 0;
  const createOrUpdateMr =
    opts.createMr ??
    vi.fn(async () => {
      createMrCalls += 1;
      return { iid: 99, webUrl: 'https://gitlab.example/mr/99' };
    });
  const marker = workflowMarker('WF#1#1', 'group/app');
  return {
    pushCount: 0,
    createMrCalls: 0,
    assertRepoAllowlisted() {},
    async ensureTargetBranchExists() {
      return { commitSha: 'base' };
    },
    async checkoutWorkingBranch() {
      return { commitSha: opts.headSha };
    },
    async pushCommit() {
      pushCount += 1;
      (this as { pushCount: number }).pushCount = pushCount;
      return { sha: NEXT };
    },
    async findMrByWorkflowMarker(_projectId, workflowMarkerValue) {
      if (workflowMarkerValue !== marker) return null;
      return opts.mrIid == null
        ? null
        : { iid: opts.mrIid, webUrl: `https://gitlab.example/mr/${opts.mrIid}` };
    },
    async createOrUpdateMr(input) {
      createMrCalls += 1;
      (this as { createMrCalls: number }).createMrCalls = createMrCalls;
      return createOrUpdateMr(input);
    },
  };
}

describe('runFix', () => {
  it('stale HEAD → no push', async () => {
    const gitlab = gitlabStub({ headSha: NEXT, mrIid: 7 });
    const store = new InMemoryArtifactStore();
    await store.putObject('s3://bucket/ci.json', '{"status":"FAILURE"}');
    const result = await runFix({
      stage: 'fix',
      jobId: 'job-1',
      workflowId: 'WF#1#1',
      repository: 'group/app',
      workingBranch: 'feature/x',
      targetBranch: 'release/1.0.0',
      approvedSpecHash: 'h1',
      expectedApprovedSpecHash: 'h1',
      failedCommitSha: FAILED,
      ciReportUri: 's3://bucket/ci.json',
      fixAttempt: 1,
      artifactsBucket: 'bucket',
      artifactStore: store,
      gitlab,
    });
    expect(result.errorCode).toBe('HL_FIX_STALE_HEAD');
    expect(gitlab.pushCount).toBe(0);
  });

  it('pushes fix commit on same MR; never creates a second MR', async () => {
    const gitlab = gitlabStub({ headSha: FAILED, mrIid: 7 });
    const store = new InMemoryArtifactStore();
    await store.putObject('s3://bucket/ci.json', '{"status":"FAILURE"}');
    const result = await runFix({
      stage: 'fix',
      jobId: 'job-2',
      workflowId: 'WF#1#1',
      repository: 'group/app',
      workingBranch: 'feature/x',
      targetBranch: 'release/1.0.0',
      approvedSpecHash: 'h1',
      expectedApprovedSpecHash: 'h1',
      failedCommitSha: FAILED,
      ciReportUri: 's3://bucket/ci.json',
      fixAttempt: 1,
      artifactsBucket: 'bucket',
      artifactStore: store,
      gitlab,
    });
    expect(result.exitStatus).toBe('SUCCEEDED');
    expect(result.mrIid).toBe(7);
    expect(result.commitSha).toBe(NEXT);
    expect(gitlab.pushCount).toBe(1);
    expect(gitlab.createMrCalls).toBe(0);
  });

  it('refuses when no existing MR (would otherwise create one)', async () => {
    const gitlab = gitlabStub({ headSha: FAILED });
    const store = new InMemoryArtifactStore();
    await store.putObject('s3://bucket/ci.json', '{}');
    const result = await runFix({
      stage: 'fix',
      jobId: 'job-3',
      workflowId: 'WF#1#1',
      repository: 'group/app',
      workingBranch: 'feature/x',
      targetBranch: 'release/1.0.0',
      approvedSpecHash: 'h1',
      expectedApprovedSpecHash: 'h1',
      failedCommitSha: FAILED,
      ciReportUri: 's3://bucket/ci.json',
      fixAttempt: 2,
      artifactsBucket: 'bucket',
      artifactStore: store,
      gitlab,
    });
    expect(result.errorCode).toBe('HL_FIX_MR_MISSING');
    expect(gitlab.pushCount).toBe(0);
    expect(gitlab.createMrCalls).toBe(0);
  });
});
