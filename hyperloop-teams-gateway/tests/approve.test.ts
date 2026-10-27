import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/bot/app.js';
import { buildSpecApprovalCard } from '../src/cards/spec-approval.js';
import type { ControlPlaneApprovalClient } from '../src/commands/approve.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SDD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('teams-gateway M3/v1.2', () => {
  it('embeds immutable spec hash, sdd commit, and expectedVersion', () => {
    const card = buildSpecApprovalCard({
      workflowId: 'WF#1',
      specHash: SPEC,
      sddCommitSha: SDD,
      reviewUrl: 'https://example.invalid',
      expectedVersion: 3,
    });
    expect(JSON.stringify(card)).toContain('sha256:');
    expect(JSON.stringify(card)).toContain(SDD);
    expect(JSON.stringify(card)).toContain('"expectedVersion":3');
  });

  it('rejects approve without verified Entra identity', async () => {
    const app = buildApp({
      controlPlane: {
        approveSpec: vi.fn(),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/commands/approve',
      payload: {
        action: 'APPROVE',
        workflowId: 'WF#1',
        expectedSpecHash: SPEC,
        expectedSddCommitSha: SDD,
        expectedVersion: 3,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('forwards server-verified identity and SDD SHA to Control Plane', async () => {
    const approveSpec = vi.fn(async () => ({ status: 'CODING' }));
    const controlPlane: ControlPlaneApprovalClient = { approveSpec };
    const app = buildApp({ controlPlane });

    const response = await app.inject({
      method: 'POST',
      url: '/commands/approve',
      headers: {
        'x-hyperloop-entra-id': 'entra-real',
        'x-hyperloop-entra-name': 'Real User',
      },
      payload: {
        action: 'APPROVE',
        workflowId: 'WF#1',
        expectedSpecHash: SPEC,
        expectedSddCommitSha: SDD,
        expectedVersion: 3,
        approver: { entraId: 'entra-spoofed' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(approveSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedSddCommitSha: SDD,
        approver: expect.objectContaining({ entraId: 'entra-real' }),
      }),
    );
  });
});
