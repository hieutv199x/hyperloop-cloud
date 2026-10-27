import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCodes, listSchemas, validate } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const validDevSpec = {
  apiVersion: 'hyperloop.dev/v1',
  kind: 'DevelopmentSpec',
  metadata: {
    project: 'transaction-banking',
    userStory: 'PAY-1234',
    revision: 1,
  },
  spec: {
    status: 'submitted',
    requirements: ['02-requirements/PAY-1234/US.md'],
    designs: ['03-designs/PAY-1234/solution-design.md'],
    acceptanceCriteria: ['04-development/PAY-1234/acceptance-criteria.md'],
    targets: [
      {
        repository: 'coc-ewallet-service',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
      },
    ],
    execution: {
      requireSpecApproval: true,
      maxAutoFixAttempts: 2,
    },
  },
};

describe('hyperloop-contracts', () => {
  it('lists all expected schemas including sdd-manifest', () => {
    expect(listSchemas()).toContain('dev-spec');
    expect(listSchemas()).toContain('sdd-manifest');
    expect(listSchemas()).toContain('concurrency-policy');
  });

  it('accepts a valid DEV-Spec object', () => {
    const result = validate('dev-spec', validDevSpec);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid release branch with INVALID_BRANCH', () => {
    const result = validate('dev-spec', {
      ...validDevSpec,
      spec: {
        ...validDevSpec.spec,
        targets: [
          {
            repository: 'coc-ewallet-service',
            workingBranch: 'feature/PAY-1234',
            targetBranch: 'main',
          },
        ],
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ErrorCodes.INVALID_BRANCH);
  });

  it('validates ci-result example fixture', () => {
    const data = JSON.parse(
      readFileSync(join(root, 'contracts/examples/ci-result.json'), 'utf8'),
    ) as unknown;
    const result = validate('ci-result', data);
    expect(result.valid).toBe(true);
  });
});
