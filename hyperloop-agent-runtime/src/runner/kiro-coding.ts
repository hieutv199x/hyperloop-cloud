/**
 * Kiro coding headless adapter (M4).
 * Flags/session behavior must be validated against the Nexus image spike.
 */
export interface KiroCodingRequest {
  workflowId: string;
  repository: string;
  approvedSpecHash: string;
  workingBranch: string;
}

export interface KiroCodingResponse {
  files: Record<string, string>;
  summary: string;
}

export async function invokeKiroCoding(
  request: KiroCodingRequest,
): Promise<KiroCodingResponse> {
  if (process.env.HYPERLOOP_KIRO_ENABLED === 'true') {
    throw new Error(
      'Kiro CLI enabled but coding headless flags are not pinned yet — complete the spike first',
    );
  }

  // Deterministic local simulator for vertical-slice tests.
  return {
    summary: `Applied plan ${request.approvedSpecHash} to ${request.repository}`,
    files: {
      'hyperloop.generated.md': `# Hyperloop coding output\n\n- workflow: ${request.workflowId}\n- repo: ${request.repository}\n- branch: ${request.workingBranch}\n- spec: ${request.approvedSpecHash}\n`,
    },
  };
}
