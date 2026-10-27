/**
 * Kiro CLI headless adapter.
 *
 * M2 spike notes (do not assume session portability between Pods):
 * - Validate installed CLI flags in the target Nexus image before production.
 * - Prefer one-shot `kiro ... --headless` style invocations with explicit inputs.
 * - Never reuse interactive session state across Job retries.
 *
 * Until the spike pins real flags, `invokeKiroPlanner` returns null and the
 * Planner role uses the deterministic local builder.
 */
export interface KiroPlannerRequest {
  workflowId: string;
  sddCommitSha: string;
  promptSkill: string;
  inputArtifactUris: string[];
}

export interface KiroPlannerResponse {
  rawOutput: string;
}

export async function invokeKiroPlanner(
  _request: KiroPlannerRequest,
): Promise<KiroPlannerResponse | null> {
  if (process.env.HYPERLOOP_KIRO_ENABLED === 'true') {
    throw new Error(
      'Kiro CLI enabled but headless flags are not pinned yet — complete the M2 spike first',
    );
  }
  return null;
}
