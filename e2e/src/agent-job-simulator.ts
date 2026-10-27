/**
 * Runs agent-runtime OUTSIDE the Control Plane process boundary (v1.3 §0.1).
 * Writes result manifests into the shared artifact store; CP only ingests them.
 */
import {
  InMemoryArtifactStore as AgentArtifactStore,
  runCoding,
  runPlanner,
} from '@hyperloop/agent-runtime';
import type { GitLabPort } from '@hyperloop/integrations';
import type { ArtifactStore } from '../../hyperloop-control-plane/src/adapters/s3/artifact-store.js';
import type { DevSpecDocument } from '../../hyperloop-control-plane/src/domain/types.js';
import type { FakeKubernetesAdapter } from '../../hyperloop-control-plane/src/adapters/kubernetes/fake-kubernetes.js';

export async function simulatePlannerJob(input: {
  jobId: string;
  workflowId: string;
  sddCommitSha: string;
  artifactsBucket: string;
  artifacts: ArtifactStore;
  kubernetes: FakeKubernetesAdapter;
  namespace: string;
  k8sJobName: string;
  devSpec: DevSpecDocument;
}): Promise<string> {
  const agentStore = new AgentArtifactStore();
  const result = await runPlanner({
    stage: 'planner',
    jobId: input.jobId,
    workflowId: input.workflowId,
    sddCommitSha: input.sddCommitSha,
    artifactsBucket: input.artifactsBucket,
    artifactStore: agentStore,
    devSpec: {
      metadata: input.devSpec.metadata,
      spec: {
        requirements: input.devSpec.spec.requirements,
        analysis: input.devSpec.spec.analysis,
        designs: input.devSpec.spec.designs,
        acceptanceCriteria: input.devSpec.spec.acceptanceCriteria,
        targets: input.devSpec.spec.targets,
      },
    },
  });

  for (const [uri, body] of agentStore.objects.entries()) {
    await input.artifacts.putObject(uri, body);
  }

  if (result.exitStatus !== 'SUCCEEDED' || !result.specHash) {
    input.kubernetes.setPhase(input.namespace, input.k8sJobName, 'Failed');
    throw new Error(result.message);
  }

  input.kubernetes.setPhase(input.namespace, input.k8sJobName, 'Succeeded');
  const resultUri =
    result.outputArtifactUris.find((u) => u.endsWith('/plan/agent-result.json')) ??
    result.outputArtifactUris[result.outputArtifactUris.length - 1];
  if (!resultUri) {
    throw new Error('Planner did not write agent-result artifact');
  }
  return resultUri;
}

export async function simulateCodingJob(input: {
  jobId: string;
  workflowId: string;
  repository: string;
  workingBranch: string;
  targetBranch: string;
  approvedSpecHash: string;
  artifactsBucket: string;
  artifacts: ArtifactStore;
  kubernetes: FakeKubernetesAdapter;
  namespace: string;
  k8sJobName: string;
  gitlab: GitLabPort;
}): Promise<string> {
  const agentStore = new AgentArtifactStore();
  const result = await runCoding({
    stage: 'coding',
    jobId: input.jobId,
    workflowId: input.workflowId,
    repository: input.repository,
    workingBranch: input.workingBranch,
    targetBranch: input.targetBranch,
    approvedSpecHash: input.approvedSpecHash,
    expectedApprovedSpecHash: input.approvedSpecHash,
    artifactsBucket: input.artifactsBucket,
    artifactStore: agentStore,
    gitlab: input.gitlab,
  });

  for (const [uri, body] of agentStore.objects.entries()) {
    await input.artifacts.putObject(uri, body);
  }

  if (result.exitStatus !== 'SUCCEEDED' || !result.commitSha || !result.mrIid) {
    input.kubernetes.setPhase(input.namespace, input.k8sJobName, 'Failed');
    throw new Error(result.message);
  }

  input.kubernetes.setPhase(input.namespace, input.k8sJobName, 'Succeeded');
  const resultUri =
    result.outputArtifactUris.find((u) => u.includes('/coding/')) ??
    result.outputArtifactUris[0];
  if (!resultUri) {
    throw new Error('Coding did not write agent-result artifact');
  }
  return resultUri;
}
