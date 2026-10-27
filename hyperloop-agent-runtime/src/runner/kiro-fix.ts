/**
 * Kiro fix headless adapter (M6 / P9).
 * Real CLI wiring is P10; simulate mode is default for tests.
 */
export interface KiroFixRequest {
  workflowId: string;
  repository: string;
  failedCommitSha: string;
  fixAttempt: 1 | 2;
  ciReportExcerpt?: string;
}

export interface KiroFixResponse {
  files: Record<string, string>;
  summary: string;
}

export async function invokeKiroFix(request: KiroFixRequest): Promise<KiroFixResponse> {
  if (process.env.HYPERLOOP_KIRO_ENABLED === 'true') {
    throw new Error(
      'Kiro CLI enabled but fix headless flags are not pinned yet — complete the spike first',
    );
  }

  return {
    summary: `Fix attempt ${request.fixAttempt} for ${request.repository} @ ${request.failedCommitSha.slice(0, 8)}`,
    files: {
      'hyperloop.fix.md': `# Hyperloop fix output\n\n- workflow: ${request.workflowId}\n- repo: ${request.repository}\n- failed: ${request.failedCommitSha}\n- attempt: ${request.fixAttempt}\n- ci: ${request.ciReportExcerpt?.slice(0, 200) ?? 'n/a'}\n`,
    },
  };
}
