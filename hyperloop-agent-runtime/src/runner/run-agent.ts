import { runCoding, type CodingInput } from '../roles/coding/index.js';
import { runFix, type FixInput } from '../roles/fix/index.js';
import { runPlanner, type PlannerInput } from '../roles/planner/index.js';


export interface AgentInput {
  stage: string;
  jobId: string;
  workflowId: string;
}

export interface AgentOutput {
  jobId: string;
  stage: string;
  exitStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  message: string;
  outputArtifactUris: string[];
  specHash?: string;
  implementationSpecUri?: string;
  planServices?: Array<{
    repository: string;
    workingBranch: string;
    targetBranch: string;
    dependsOn: string[];
  }>;
  commitSha?: string;
  mrIid?: number;
  branch?: string;
  errorCode?: string;
}

export async function runAgent(
  input: AgentInput | PlannerInput | CodingInput | FixInput,
): Promise<AgentOutput> {
  switch (input.stage) {
    case 'planner':
      return runPlanner(input);
    case 'coding':
      return runCoding(input);
    case 'fix':
      return runFix(input);
    default:
      return {
        jobId: input.jobId,
        stage: input.stage,
        exitStatus: 'FAILED',
        message: `Unknown stage: ${input.stage}`,
        outputArtifactUris: [],
      };
  }
}
