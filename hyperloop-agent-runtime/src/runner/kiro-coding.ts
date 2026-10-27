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
  const { execKiro, parseKiroJsonStdout, resolveKiroMode } = await import('./kiro-cli.js');
  if (resolveKiroMode() === 'real') {
    const argsEnv = process.env.HYPERLOOP_KIRO_ARGS;
    if (!argsEnv) {
      throw new Error(
        'Kiro CLI real mode requires HYPERLOOP_KIRO_ARGS — complete docs/spikes/kiro-cli-headless.md',
      );
    }
    const args = JSON.parse(argsEnv) as string[];
    const result = await execKiro({ args });
    return parseKiroJsonStdout<KiroCodingResponse>(result.stdout);
  }

  // Deterministic local simulator for vertical-slice tests.
  return {
    summary: `Applied plan ${request.approvedSpecHash} to ${request.repository}`,
    files: {
      'hyperloop.generated.md': `# Hyperloop coding output\n\n- workflow: ${request.workflowId}\n- repo: ${request.repository}\n- branch: ${request.workingBranch}\n- spec: ${request.approvedSpecHash}\n`,
    },
  };
}
