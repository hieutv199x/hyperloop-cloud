import { describe, expect, it } from 'vitest';
import { verifySharedSecret } from '../src/common/auth.js';
import { InMemoryGitLabClient } from '../src/gitlab/client.js';
import { JenkinsCallbackParser } from '../src/jenkins/callback.js';

describe('integrations scaffold', () => {
  it('verifies shared secrets', () => {
    expect(verifySharedSecret('secret', 'secret')).toBe(true);
    expect(verifySharedSecret('nope', 'secret')).toBe(false);
  });

  it('forbids direct release branch push', () => {
    const client = new InMemoryGitLabClient(new Set(['*']));
    expect(() => client.assertNotReleaseBranchPush('release/2.5.0')).toThrow(/forbidden/i);
  });

  it('detects stale CI callbacks', () => {
    const parser = new JenkinsCallbackParser();
    expect(
      parser.isStale(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
    ).toBe(true);
  });
});
