import {
  buildArtifactUri,
  type ArtifactStore,
} from '../../artifacts/types.js';
import { invokeKiroPlanner } from '../../runner/kiro-cli.js';
import type { AgentInput, AgentOutput } from '../../runner/run-agent.js';
import {
  buildImplementationSpec,
  type PlannerDevSpec,
} from './build-implementation-spec.js';
import {
  SDDPackageLoader,
  type SddManifestLike,
} from './sdd-package-loader.js';

export interface PlannerInput extends AgentInput {
  stage: 'planner';
  sddCommitSha: string;
  artifactsBucket: string;
  artifactStore: ArtifactStore;
  /** Legacy/direct DEV-Spec; prefer sddPackage for v1.2 SDD-only planning. */
  devSpec?: PlannerDevSpec;
  /** Pinned SDD package — sole required planning context when provided. */
  sddPackage?: {
    manifest: SddManifestLike;
    files: Record<string, string>;
    revision?: number;
  };
  inputArtifactUris?: string[];
}

export async function runPlanner(input: PlannerInput | AgentInput): Promise<AgentOutput> {
  if (!isPlannerInput(input)) {
    return {
      jobId: input.jobId,
      stage: 'planner',
      exitStatus: 'FAILED',
      message: 'Planner requires SDD package or devSpec, plus artifactStore and artifactsBucket',
      outputArtifactUris: [],
    };
  }

  let devSpec: PlannerDevSpec;
  try {
    if (input.sddPackage) {
      const loaded = new SDDPackageLoader().load({
        sddCommitSha: input.sddCommitSha,
        manifest: input.sddPackage.manifest,
        packageFiles: input.sddPackage.files,
        revision: input.sddPackage.revision,
      });
      devSpec = loaded.plannerDevSpec;
    } else if (input.devSpec) {
      devSpec = input.devSpec;
    } else {
      return {
        jobId: input.jobId,
        stage: 'planner',
        exitStatus: 'FAILED',
        message: 'Planner requires sddPackage or devSpec',
        outputArtifactUris: [],
      };
    }
  } catch (error) {
    return {
      jobId: input.jobId,
      stage: 'planner',
      exitStatus: 'FAILED',
      message: error instanceof Error ? error.message : 'SDD package load failed',
      outputArtifactUris: [],
      errorCode: 'HL_PLANNER_SDD_LOAD_FAILED',
    };
  }

  // Attempt real Kiro first; fall back to deterministic builder for local/M2.
  await invokeKiroPlanner({
    workflowId: input.workflowId,
    sddCommitSha: input.sddCommitSha,
    promptSkill: 'planner',
    inputArtifactUris: input.inputArtifactUris ?? [],
  });

  const implementationSpec = buildImplementationSpec(input.workflowId, devSpec);
  const safeWorkflowKey = input.workflowId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const specKey = `${safeWorkflowKey}/plan/implementation-spec.json`;
  const resultKey = `${safeWorkflowKey}/plan/agent-result.json`;
  const specUri = buildArtifactUri(input.artifactsBucket, specKey);
  const resultUri = buildArtifactUri(input.artifactsBucket, resultKey);

  await input.artifactStore.putObject(
    specUri,
    JSON.stringify(implementationSpec, null, 2),
    'application/json',
  );

  const output: AgentOutput & {
    specHash: string;
    implementationSpecUri: string;
    planServices: Array<{
      repository: string;
      workingBranch: string;
      targetBranch: string;
      dependsOn: string[];
    }>;
  } = {
    jobId: input.jobId,
    stage: 'planner',
    exitStatus: 'SUCCEEDED',
    message: 'Planner produced Implementation Spec and DAG',
    outputArtifactUris: [specUri, resultUri],
    specHash: implementationSpec.metadata.specHash,
    implementationSpecUri: specUri,
    planServices: implementationSpec.spec.services.map((s) => ({
      repository: s.repository,
      workingBranch: s.workingBranch,
      targetBranch: s.targetBranch,
      dependsOn: s.dependsOn,
    })),
  };

  await input.artifactStore.putObject(resultUri, JSON.stringify(output, null, 2), 'application/json');
  return output;
}

function isPlannerInput(input: AgentInput | PlannerInput): input is PlannerInput {
  return (
    input.stage === 'planner' &&
    ('devSpec' in input || 'sddPackage' in input) &&
    'artifactStore' in input &&
    'artifactsBucket' in input &&
    'sddCommitSha' in input
  );
}

export { buildImplementationSpec } from './build-implementation-spec.js';
export { SDDPackageLoader } from './sdd-package-loader.js';
export type { LoadedSddPlannerContext, SddManifestLike } from './sdd-package-loader.js';
