import { createHash } from 'node:crypto';

export interface PlannerDevSpec {
  metadata: {
    project: string;
    userStory: string;
    revision: number;
  };
  spec: {
    requirements: string[];
    analysis?: string[];
    designs: string[];
    acceptanceCriteria?: string[];
    targets: Array<{
      repository: string;
      workingBranch: string;
      targetBranch: string;
    }>;
  };
}

export interface ImplementationSpecDocument {
  apiVersion: 'hyperloop.dev/v1';
  kind: 'ImplementationSpec';
  metadata: {
    workflowId: string;
    specHash: string;
    revision: number;
    sourceDevSpecRevision: number;
  };
  spec: {
    summary: string;
    services: Array<{
      repository: string;
      workingBranch: string;
      targetBranch: string;
      changeSummary: string;
      dependsOn: string[];
    }>;
    dag: {
      nodes: string[];
      edges: Array<{ from: string; to: string }>;
    };
  };
}

/**
 * Deterministic planner output for M2 (no Kiro session portability assumed).
 * Real Kiro CLI headless invocation is wrapped behind invokeKiroPlanner and
 * validated in a spike; this builder is the contract-stable fallback/simulator.
 */
export function buildImplementationSpec(
  workflowId: string,
  devSpec: PlannerDevSpec,
): ImplementationSpecDocument {
  const nodes = devSpec.spec.targets.map((t) => t.repository);
  const edges: Array<{ from: string; to: string }> = [];
  // Linear dependency heuristic: preserve DEV-Spec target order.
  for (let i = 1; i < nodes.length; i += 1) {
    edges.push({ from: nodes[i - 1]!, to: nodes[i]! });
  }

  const withoutHash: Omit<ImplementationSpecDocument, 'metadata'> & {
    metadata: Omit<ImplementationSpecDocument['metadata'], 'specHash'> & { specHash?: string };
  } = {
    apiVersion: 'hyperloop.dev/v1',
    kind: 'ImplementationSpec',
    metadata: {
      workflowId,
      revision: 1,
      sourceDevSpecRevision: devSpec.metadata.revision,
    },
    spec: {
      summary: `Implementation plan for ${devSpec.metadata.userStory} in ${devSpec.metadata.project}`,
      services: devSpec.spec.targets.map((target, index) => ({
        repository: target.repository,
        workingBranch: target.workingBranch,
        targetBranch: target.targetBranch,
        changeSummary: `Apply ${devSpec.metadata.userStory} changes to ${target.repository}`,
        dependsOn: index === 0 ? [] : [nodes[index - 1]!],
      })),
      dag: { nodes, edges },
    },
  };

  const canonical = JSON.stringify(withoutHash);
  const specHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

  return {
    ...withoutHash,
    metadata: {
      ...withoutHash.metadata,
      specHash,
    },
  };
}
