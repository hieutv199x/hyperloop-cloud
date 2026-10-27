import type { VerifiedTeamsIdentity } from '../security/identity.js';

export interface ControlPlaneApprovalClient {
  approveSpec(input: {
    workflowId: string;
    approvedSpecHash: string;
    approvedSddCommitSha: string;
    decision: 'APPROVED' | 'SPEC_CHANGES_REQUESTED' | 'REJECTED';
    expectedVersion: number;
    approver: VerifiedTeamsIdentity;
    comment?: string;
  }): Promise<unknown>;
}

export class HttpControlPlaneClient implements ControlPlaneApprovalClient {
  constructor(private readonly baseUrl: string) {}

  async approveSpec(input: {
    workflowId: string;
    approvedSpecHash: string;
    approvedSddCommitSha: string;
    decision: 'APPROVED' | 'SPEC_CHANGES_REQUESTED' | 'REJECTED';
    expectedVersion: number;
    approver: VerifiedTeamsIdentity;
    comment?: string;
  }): Promise<unknown> {
    const response = await fetch(
      `${this.baseUrl}/workflows/${encodeURIComponent(input.workflowId)}/approve-spec`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hyperloop-entra-id': input.approver.entraId,
          'x-hyperloop-entra-name': input.approver.displayName,
        },
        body: JSON.stringify({
          approvedSpecHash: input.approvedSpecHash,
          approvedSddCommitSha: input.approvedSddCommitSha,
          decision: input.decision,
          expectedVersion: input.expectedVersion,
          // Body approver is informational; Control Plane prefers headers.
          approver: input.approver,
          comment: input.comment,
        }),
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        typeof payload === 'object' && payload && 'error' in payload
          ? String((payload as { error: string }).error)
          : `Control Plane approval failed (${response.status})`,
      );
    }
    return payload;
  }
}

export async function handleApprovalCommand(
  client: ControlPlaneApprovalClient,
  identity: VerifiedTeamsIdentity,
  body: {
    action?: string;
    workflowId?: string;
    expectedSpecHash?: string;
    expectedSddCommitSha?: string;
    expectedVersion?: number;
    comment?: string;
  },
): Promise<unknown> {
  if (
    !body.workflowId ||
    !body.expectedSpecHash ||
    !body.expectedSddCommitSha ||
    body.expectedVersion == null ||
    !body.action
  ) {
    throw new Error('Invalid approval command payload');
  }

  const decision =
    body.action === 'APPROVE' || body.action === 'APPROVED'
      ? 'APPROVED'
      : body.action === 'SPEC_CHANGES_REQUESTED'
        ? 'SPEC_CHANGES_REQUESTED'
        : body.action === 'REJECTED'
          ? 'REJECTED'
          : null;

  if (!decision) {
    throw new Error(`Unknown action: ${body.action}`);
  }

  return client.approveSpec({
    workflowId: body.workflowId,
    approvedSpecHash: body.expectedSpecHash,
    approvedSddCommitSha: body.expectedSddCommitSha,
    decision,
    expectedVersion: body.expectedVersion,
    approver: identity,
    comment: body.comment,
  });
}
