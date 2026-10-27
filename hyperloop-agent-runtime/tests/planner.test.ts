import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../src/artifacts/memory-store.js';
import { buildImplementationSpec, runPlanner } from '../src/roles/planner/index.js';

const devSpec = {
  metadata: {
    project: 'transaction-banking',
    userStory: 'PAY-1234',
    revision: 1,
  },
  spec: {
    requirements: ['02-requirements/PAY-1234/US.md'],
    designs: ['03-designs/PAY-1234/solution-design.md'],
    targets: [
      {
        repository: 'coc-ewallet-service',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
      },
      {
        repository: 'access-control-adapter',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
      },
    ],
  },
};

describe('planner M2', () => {
  it('builds deterministic Implementation Spec with DAG and sha256 hash', () => {
    const a = buildImplementationSpec('WF#PAY-1234#1', devSpec);
    const b = buildImplementationSpec('WF#PAY-1234#1', devSpec);
    expect(a.metadata.specHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(a.metadata.specHash).toBe(b.metadata.specHash);
    expect(a.spec.dag.nodes).toEqual([
      'coc-ewallet-service',
      'access-control-adapter',
    ]);
    expect(a.spec.dag.edges).toEqual([
      { from: 'coc-ewallet-service', to: 'access-control-adapter' },
    ]);
  });

  it('uploads spec + agent-result artifacts and exits successfully', async () => {
    const store = new InMemoryArtifactStore();
    const result = await runPlanner({
      stage: 'planner',
      jobId: 'job-1',
      workflowId: 'WF#PAY-1234#1',
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: store,
      devSpec,
    });

    expect(result.exitStatus).toBe('SUCCEEDED');
    expect(result.specHash).toMatch(/^sha256:/);
    expect(result.implementationSpecUri).toContain('s3://hyperloop-artifacts/');
    expect(store.objects.has(result.implementationSpecUri!)).toBe(true);
    const uploaded = JSON.parse(store.objects.get(result.implementationSpecUri!)!) as {
      metadata: { specHash: string };
    };
    expect(uploaded.metadata.specHash).toBe(result.specHash);
  });

  it('does not push code or create pods (no side-channel fields)', async () => {
    const store = new InMemoryArtifactStore();
    const result = await runPlanner({
      stage: 'planner',
      jobId: 'job-2',
      workflowId: 'WF#PAY-9#1',
      sddCommitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: store,
      devSpec,
    });
    expect(result.commitSha).toBeUndefined();
    expect(result.mrIid).toBeUndefined();
  });
});
