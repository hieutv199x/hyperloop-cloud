import type { PlannerDevSpec } from './build-implementation-spec.js';

export interface SddManifestLike {
  apiVersion: string;
  kind: string;
  metadata: {
    devSpecId: string;
    project: string;
  };
  spec: {
    devSpecPath: string;
    requirements: string[];
    analysis?: string[];
    designs: string[];
    acceptanceCriteria: string[];
    services: Array<{
      name: string;
      repository: string;
      workingBranch: string;
      targetBranch: string;
      dependsOn: string[];
    }>;
  };
}

export interface LoadedSddPlannerContext {
  sddCommitSha: string;
  manifest: SddManifestLike;
  /** Planner input derived solely from the pinned SDD package. */
  plannerDevSpec: PlannerDevSpec;
}

/**
 * Planner-side loader: builds planning context from a pinned SDD package only.
 * Source-repository checkout is intentionally out of scope (Coding/Fix only).
 */
export class SDDPackageLoader {
  load(input: {
    sddCommitSha: string;
    manifest: SddManifestLike;
    packageFiles: Record<string, string>;
    revision?: number;
  }): LoadedSddPlannerContext {
    if (!/^[a-f0-9]{40}$/i.test(input.sddCommitSha)) {
      throw new Error(`Invalid pinned SDD commit SHA: ${input.sddCommitSha}`);
    }

    const required = [
      input.manifest.spec.devSpecPath,
      ...input.manifest.spec.requirements,
      ...input.manifest.spec.designs,
      ...input.manifest.spec.acceptanceCriteria,
    ];
    for (const path of required) {
      if (!(path in input.packageFiles)) {
        throw new Error(`SDD package missing required document: ${path}`);
      }
    }

    const plannerDevSpec: PlannerDevSpec = {
      metadata: {
        project: input.manifest.metadata.project,
        userStory: input.manifest.metadata.devSpecId,
        revision: input.revision ?? 1,
      },
      spec: {
        requirements: [...input.manifest.spec.requirements],
        analysis: input.manifest.spec.analysis ? [...input.manifest.spec.analysis] : undefined,
        designs: [...input.manifest.spec.designs],
        acceptanceCriteria: [...input.manifest.spec.acceptanceCriteria],
        targets: input.manifest.spec.services.map((s) => ({
          repository: s.repository,
          workingBranch: s.workingBranch,
          targetBranch: s.targetBranch,
        })),
      },
    };

    return {
      sddCommitSha: input.sddCommitSha,
      manifest: input.manifest,
      plannerDevSpec,
    };
  }
}
