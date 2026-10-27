import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../src/artifacts/memory-store.js';
import { runPlanner } from '../src/roles/planner/index.js';
import { SDDPackageLoader } from '../src/roles/planner/sdd-package-loader.js';
import { runCoding } from '../src/roles/coding/index.js';
import { InMemoryGitLabClient } from '@hyperloop/integrations';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const manifest = {
  apiVersion: 'hyperloop.dev/v1',
  kind: 'SDDPackage',
  metadata: { devSpecId: 'PAY-1234', project: 'payment-sdd' },
  spec: {
    devSpecPath: '04-development/PAY-1234/dev-spec.yaml',
    requirements: ['02-requirements/PAY-1234.md'],
    designs: ['03-design/architecture.md'],
    acceptanceCriteria: ['04-development/PAY-1234/acceptance-criteria.md'],
    services: [
      {
        name: 'wallet-service',
        repository: 'group/wallet-service',
        workingBranch: 'feature/PAY-1234',
        targetBranch: 'release/2.5.0',
        dependsOn: [],
      },
    ],
  },
};

const files = {
  [manifest.spec.devSpecPath]: 'kind: DevelopmentSpec',
  [manifest.spec.requirements[0]!]: '# req',
  [manifest.spec.designs[0]!]: '# design',
  [manifest.spec.acceptanceCriteria[0]!]: '# ac',
};

describe('SDDPackageLoader / PlannerAgentRunner SDD-only', () => {
  it('builds planner context from pinned SDD without source-repo checkout', () => {
    const loaded = new SDDPackageLoader().load({
      sddCommitSha: SHA,
      manifest,
      packageFiles: files,
    });
    expect(loaded.plannerDevSpec.metadata.userStory).toBe('PAY-1234');
    expect(loaded.plannerDevSpec.spec.targets[0]?.repository).toBe('group/wallet-service');
  });

  it('runPlanner accepts sddPackage and produces Implementation Spec', async () => {
    const store = new InMemoryArtifactStore();
    const result = await runPlanner({
      stage: 'planner',
      jobId: 'job-sdd-1',
      workflowId: 'WF#PAY-1234#1',
      sddCommitSha: SHA,
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: store,
      sddPackage: { manifest, files },
    });
    expect(result.exitStatus).toBe('SUCCEEDED');
    expect(result.specHash).toMatch(/^sha256:/);
    expect(result.planServices?.[0]?.targetBranch).toBe('release/2.5.0');
  });

  it('10) approved plan hash mismatch at coding startup → no mutation', async () => {
    const gl = new InMemoryGitLabClient(new Set(['group/wallet-service']), [
      { projectId: 'group/wallet-service', name: 'release/2.5.0' },
    ]);
    const result = await runCoding({
      stage: 'coding',
      jobId: 'job-c',
      workflowId: 'WF#PAY-1234#1',
      repository: 'group/wallet-service',
      workingBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      approvedSpecHash: SPEC,
      expectedApprovedSpecHash: 'sha256:deadbeef',
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: new InMemoryArtifactStore(),
      gitlab: gl,
    });
    expect(result.errorCode).toBe('HL_CODING_SPEC_HASH_MISMATCH');
    expect(gl.commits).toHaveLength(0);
  });

  it('fenced execution cannot push', async () => {
    const gl = new InMemoryGitLabClient(new Set(['group/wallet-service']), [
      { projectId: 'group/wallet-service', name: 'release/2.5.0' },
    ]);
    const result = await runCoding({
      stage: 'coding',
      jobId: 'job-fence',
      workflowId: 'WF#PAY-1234#1',
      repository: 'group/wallet-service',
      workingBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      approvedSpecHash: SPEC,
      expectedApprovedSpecHash: SPEC,
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: new InMemoryArtifactStore(),
      gitlab: gl,
      assertPushAllowed: () => {
        throw new Error('Execution fenced for workflow WF#PAY-1234#1; further push denied');
      },
    });
    expect(result.errorCode).toBe('HL_CODING_EXECUTION_FENCED');
    expect(gl.commits).toHaveLength(0);
  });
});
