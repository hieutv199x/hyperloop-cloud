import { describe, expect, it } from 'vitest';
import { buildSpecApprovalCard } from '../src/cards/spec-approval.js';

describe('teams-gateway cards', () => {
  it('embeds immutable spec hash and sdd commit', () => {
    const card = buildSpecApprovalCard({
      workflowId: 'WF#1',
      specHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reviewUrl: 'https://example.invalid',
      expectedVersion: 2,
    });
    expect(JSON.stringify(card)).toContain('sha256:');
    expect(JSON.stringify(card)).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });
});
