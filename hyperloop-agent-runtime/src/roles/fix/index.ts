import type { AgentInput, AgentOutput } from '../../runner/run-agent.js';

export async function runFix(input: AgentInput): Promise<AgentOutput> {
  return {
    jobId: input.jobId,
    stage: 'fix',
    exitStatus: 'SUCCEEDED',
    message: 'Fix scaffold — bounded CI fix loop lands in M6',
    outputArtifactUris: [],
  };
}
