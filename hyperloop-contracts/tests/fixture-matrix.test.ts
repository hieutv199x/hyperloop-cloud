import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCodes, listSchemas, validate, type SchemaName } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)));
const validDir = join(root, 'fixtures', 'valid');
const schemaByFixture: Record<string, SchemaName> = {
  'sdd-manifest.json': 'sdd-manifest',
  'dev-spec.json': 'dev-spec',
  'implementation-spec.json': 'implementation-spec',
  'workflow-event.json': 'workflow-event',
  'agent-job-request.json': 'agent-job-request',
  'agent-result.json': 'agent-result',
  'approval-decision.json': 'approval-decision',
  'job-queue-request.json': 'job-queue-request',
  'job-reservation.json': 'job-reservation',
  'concurrency-policy.json': 'concurrency-policy',
  'scheduler-event.json': 'scheduler-event',
};

describe('M0 fixture matrix', () => {
  it('covers every schema with a valid fixture', () => {
    const covered = new Set(Object.values(schemaByFixture));
    // ci-result is covered by contracts/examples/ci-result.json
    covered.add('ci-result');
    for (const schema of listSchemas()) {
      expect(covered.has(schema), `missing valid fixture for ${schema}`).toBe(true);
    }
  });

  for (const file of readdirSync(validDir)) {
    it(`accepts valid fixture ${file}`, () => {
      const schema = schemaByFixture[file];
      expect(schema).toBeTruthy();
      const data = JSON.parse(readFileSync(join(validDir, file), 'utf8')) as unknown;
      const result = validate(schema, data);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });
  }

  it('rejects missing workflow-event envelope fields', () => {
    const result = validate('workflow-event', {
      eventId: 'evt-1',
      eventType: 'x',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_EVENT_ENVELOPE);
  });

  it('rejects invalid approvedSpecHash', () => {
    const result = validate('approval-decision', {
      workflowId: 'WF#1',
      approvedSpecHash: 'not-a-hash',
      approver: { entraId: 'u1', displayName: 'A' },
      decision: 'APPROVED',
      expectedVersion: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_SPEC_HASH);
  });

  it('rejects maxAutoFixAttempts above 2', () => {
    const result = validate('dev-spec', {
      apiVersion: 'hyperloop.dev/v1',
      kind: 'DevelopmentSpec',
      metadata: { project: 'p', userStory: 'US-1', revision: 1 },
      spec: {
        status: 'submitted',
        requirements: ['r.md'],
        designs: ['d.md'],
        acceptanceCriteria: ['ac.md'],
        targets: [
          {
            repository: 'svc',
            workingBranch: 'feature/x',
            targetBranch: 'release/1.0.0',
          },
        ],
        execution: { requireSpecApproval: true, maxAutoFixAttempts: 3 },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_SCHEMA);
  });

  it('rejects concurrency policy not equal to 100', () => {
    const result = validate('concurrency-policy', {
      globalMaxConcurrentJobs: 50,
      priorities: { fix: 100, coding: 50, planner: 10 },
      softTargets: { fix: 20, coding: 65, planner: 15 },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects agent-job-request with non-release targetBranch', () => {
    const result = validate('agent-job-request', {
      jobId: 'j1',
      workflowId: 'WF#1',
      stage: 'coding',
      attempt: 1,
      approvedSpecHash:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      inputArtifactUris: ['s3://bucket/a'],
      branchContract: {
        workingBranch: 'feature/x',
        targetBranch: 'develop',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_BRANCH);
  });
});
