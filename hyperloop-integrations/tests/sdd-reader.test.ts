import { describe, expect, it } from 'vitest';
import { DevSpecChangeDetector } from '../src/gitlab/dev-spec-change-detector.js';
import { InMemoryGitLabSDDReader } from '../src/gitlab/sdd-reader.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('GitLabSDDReader + DevSpecChangeDetector', () => {
  it('fetches pinned package at exact commit SHA', async () => {
    const reader = new InMemoryGitLabSDDReader();
    reader.seed('payment-sdd', SHA, {
      'hyperloop.sdd.json': '{"kind":"SDDPackage"}',
      '04-development/PAY-1234/dev-spec.yaml': 'kind: DevelopmentSpec',
    });

    const pkg = await reader.fetchPinnedPackage({
      sddProject: 'payment-sdd',
      sddCommitSha: SHA,
      paths: ['hyperloop.sdd.json'],
    });
    expect(pkg.files['hyperloop.sdd.json']).toContain('SDDPackage');
  });

  it('rejects invalid SHA and missing package', async () => {
    const reader = new InMemoryGitLabSDDReader();
    await expect(
      reader.fetchPinnedPackage({
        sddProject: 'payment-sdd',
        sddCommitSha: 'not-a-sha',
      }),
    ).rejects.toThrow(/Invalid pinned SDD commit SHA/);
    await expect(
      reader.fetchPinnedPackage({
        sddProject: 'payment-sdd',
        sddCommitSha: SHA,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('dedupes deliveries and ignores unrelated paths', () => {
    const detector = new DevSpecChangeDetector();
    const first = detector.evaluate({
      eventId: 'evt-1',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA,
      changedPaths: ['04-development/PAY-1234/dev-spec.yaml'],
    });
    const dup = detector.evaluate({
      eventId: 'evt-1',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA,
      changedPaths: ['04-development/PAY-1234/dev-spec.yaml'],
    });
    const unrelated = detector.evaluate({
      eventId: 'evt-2',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA,
      changedPaths: ['README.md'],
    });

    expect(first.action).toBe('process');
    expect(dup.action).toBe('duplicate');
    expect(unrelated.action).toBe('ignore');
  });
});
