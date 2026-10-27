export interface SpecApprovalCardInput {
  workflowId: string;
  specHash: string;
  sddCommitSha: string;
  reviewUrl: string;
  expectedVersion: number;
}

export function buildSpecApprovalCard(input: SpecApprovalCardInput) {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: 'Hyperloop Implementation Spec Approval',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Workflow', value: input.workflowId },
          { title: 'Spec Hash', value: input.specHash },
          { title: 'SDD Commit', value: input.sddCommitSha },
          { title: 'Expected Version', value: String(input.expectedVersion) },
        ],
      },
      {
        type: 'TextBlock',
        text: `Review: ${input.reviewUrl}`,
        wrap: true,
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Approve',
        data: {
          action: 'APPROVE',
          workflowId: input.workflowId,
          expectedSpecHash: input.specHash,
          expectedSddCommitSha: input.sddCommitSha,
          expectedVersion: input.expectedVersion,
        },
      },
      {
        type: 'Action.Submit',
        title: 'Request Changes',
        data: {
          action: 'SPEC_CHANGES_REQUESTED',
          workflowId: input.workflowId,
          expectedSpecHash: input.specHash,
          expectedSddCommitSha: input.sddCommitSha,
          expectedVersion: input.expectedVersion,
        },
      },
    ],
  };
}
