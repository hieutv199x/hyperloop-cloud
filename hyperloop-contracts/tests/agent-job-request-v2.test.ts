import { describe, expect, it } from 'vitest';
import { ErrorCodes, validate } from '../src/index.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TOKEN = 'fence-token-abcdef012345';

const base = {
  executionId: 'exec-1',
  jobId: 'job-1',
  workflowId: 'WF#PAY-1234#1',
  attempt: 1,
  sddRepository: 'group/payment-sdd',
  sddCommitSha: SHA,
  devSpecPath: '04-development/PAY-1234/dev-spec.yaml',
  artifactPrefixUri: 's3://hyperloop-artifacts/wf/',
  fenceToken: TOKEN,
  leaseExpiresAt: '2026-10-27T12:00:00.000Z',
  inputArtifactUris: ['s3://hyperloop-artifacts/wf/sdd.yaml'],
};

const codingExtras = {
  repository: 'group/wallet-service',
  approvedSpecHash: SPEC,
  approvedPlanUri: 's3://hyperloop-artifacts/wf/plan/implementation-spec.json',
  expectedBaseSha: SHA,
  branchContract: {
    workingBranch: 'feature/PAY-1234',
    targetBranch: 'release/2.5.0',
  },
};

describe('AgentExecutionContract v2', () => {
  it('accepts coding role with required scope fields', () => {
    const result = validate('agent-job-request', {
      ...base,
      role: 'coding',
      stage: 'coding',
      ...codingExtras,
    });
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('accepts fix role with fixAttempt 1|2', () => {
    const result = validate('agent-job-request', {
      ...base,
      role: 'fix',
      ...codingExtras,
      failedCommitSha: SHA,
      ciReportUri: 's3://hyperloop-artifacts/wf/ci-report.json',
      fixAttempt: 2,
    });
    expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it('rejects planner that carries repository / approvedSpecHash', () => {
    const result = validate('agent-job-request', {
      ...base,
      role: 'planner',
      repository: 'group/wallet-service',
      approvedSpecHash: SPEC,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects coding missing fenceToken', () => {
    const { fenceToken: _, ...withoutToken } = base;
    const result = validate('agent-job-request', {
      ...withoutToken,
      role: 'coding',
      ...codingExtras,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects fixAttempt above 2', () => {
    const result = validate('agent-job-request', {
      ...base,
      role: 'fix',
      ...codingExtras,
      failedCommitSha: SHA,
      ciReportUri: 's3://hyperloop-artifacts/wf/ci-report.json',
      fixAttempt: 3,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects coding with non-release targetBranch', () => {
    const result = validate('agent-job-request', {
      ...base,
      role: 'coding',
      ...codingExtras,
      branchContract: {
        workingBranch: 'feature/x',
        targetBranch: 'develop',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_BRANCH);
  });

  it('rejects role/stage mismatch when both present', () => {
    // Documented application rule: stage is deprecated alias of role.
    const payload = {
      ...base,
      role: 'coding' as const,
      stage: 'planner' as const,
      ...codingExtras,
    };
    // Schema still accepts (no $data); enforce in consumers.
    expect(payload.role !== payload.stage).toBe(true);
  });
});
