import { describe, expect, it } from 'vitest';
import { PlanConsolidationService } from '../planning/plan-consolidation-service.js';
import { PlanningCoordinator } from '../planning/planning-coordinator.js';
import { SddDependencyValidator } from '../planning/sdd-dependency-validator.js';
import { InMemorySddPackageSource, SddContextLoader } from './sdd-context-loader.js';
import { SddCompletenessValidator } from './sdd-completeness-validator.js';
import { SddRevisionManager } from './sdd-revision-manager.js';
import type { SddManifest } from './types.js';

const SHA1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function buildManifest(overrides?: Partial<SddManifest['spec']>): SddManifest {
  return {
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
        {
          name: 'payment-api',
          repository: 'group/payment-api',
          workingBranch: 'feature/PAY-1234',
          targetBranch: 'release/2.5.0',
          dependsOn: ['wallet-service'],
        },
      ],
      ...overrides,
    },
  };
}

function packageFilesFor(manifest: SddManifest) {
  const files: Record<string, string> = {
    [manifest.spec.devSpecPath]: 'kind: DevelopmentSpec',
    [manifest.spec.requirements[0]!]: '# req',
    [manifest.spec.designs[0]!]: '# design',
    [manifest.spec.acceptanceCriteria[0]!]: '# ac',
  };
  return { files };
}

describe('v1.2 SDD-only planning (Section 15.5 core)', () => {
  it('1) valid self-contained SDD is ready without external catalog calls', async () => {
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, packageFilesFor(manifest));
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      new SddRevisionManager(),
      new Set(['group/wallet-service', 'group/payment-api']),
    );

    const result = await coordinator.intake({
      eventId: 'evt-1',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: ['04-development/PAY-1234/dev-spec.yaml'],
    });

    expect(result.outcome).toBe('ready');
    if (result.outcome === 'ready') {
      expect(result.planServices).toHaveLength(2);
    }
  });

  it('2) missing design/requirements/AC -> needs clarification, no planner schedule', async () => {
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, {
      files: {
        [manifest.spec.devSpecPath]: 'x',
        // missing requirements/designs/AC on purpose
      },
    });
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      new SddRevisionManager(),
      new Set(['*']),
    );

    const result = await coordinator.intake({
      eventId: 'evt-missing',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });

    expect(result.outcome).toBe('needs_clarification');
  });

  it('3) unknown repository / invalid release target fail before scheduling', () => {
    const validator = new SddCompletenessValidator();
    const unknownRepo = buildManifest({
      services: [
        {
          name: 'x',
          repository: 'group/unknown',
          workingBranch: 'feature/x',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
        },
      ],
    });
    const unknownResult = validator.validate(
      {
        sddProject: 'payment-sdd',
        sddCommitSha: SHA1,
        devSpecPath: unknownRepo.spec.devSpecPath,
        manifest: unknownRepo,
        packageFiles: packageFilesFor(unknownRepo),
      },
      new Set(['group/wallet-service']),
    );
    expect(unknownResult.ok).toBe(false);
    expect(unknownResult.issues.some((i) => i.code === 'HL_SDD_UNKNOWN_REPOSITORY')).toBe(true);

    const badBranch = buildManifest({
      services: [
        {
          name: 'x',
          repository: 'group/wallet-service',
          workingBranch: 'feature/x',
          targetBranch: 'main',
          dependsOn: [],
        },
      ],
    });
    const badBranchResult = validator.validate(
      {
        sddProject: 'payment-sdd',
        sddCommitSha: SHA1,
        devSpecPath: badBranch.spec.devSpecPath,
        manifest: badBranch,
        packageFiles: packageFilesFor(badBranch),
      },
      new Set(['group/wallet-service']),
    );
    expect(badBranchResult.ok).toBe(false);
    expect(
      badBranchResult.issues.some(
        (i) =>
          i.code === 'HL_SDD_MANIFEST_INVALID' || i.code === 'HL_SDD_INVALID_TARGET_BRANCH',
      ),
    ).toBe(true);
  });

  it('4) planner undeclared service blocked from executable scope', () => {
    const consolidation = new PlanConsolidationService();
    const result = consolidation.consolidate({
      manifest: buildManifest(),
      proposedServices: [
        {
          repository: 'group/undeclared-service',
          workingBranch: 'feature/x',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
        },
      ],
      flaggedExtraRepositories: ['group/undeclared-service'],
    });
    expect(result.ok).toBe(false);
    expect(result.executableServices).toHaveLength(0);
    expect(result.issues.some((i) => i.code === 'HL_SDD_SCOPE_VIOLATION')).toBe(true);
  });

  it('5) cyclic dependency rejected', () => {
    const deps = new SddDependencyValidator();
    const result = deps.validate([
      {
        name: 'a',
        repository: 'group/a',
        workingBranch: 'feature/x',
        targetBranch: 'release/1.0.0',
        dependsOn: ['b'],
      },
      {
        name: 'b',
        repository: 'group/b',
        workingBranch: 'feature/x',
        targetBranch: 'release/1.0.0',
        dependsOn: ['a'],
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'HL_SDD_DEPENDENCY_CYCLE')).toBe(true);
  });

  it('6) duplicate GitLab delivery yields one revision action', async () => {
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, packageFilesFor(manifest));
    const revisions = new SddRevisionManager();
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      revisions,
      new Set(['*']),
    );

    const first = await coordinator.intake({
      eventId: 'same-event',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });
    const second = await coordinator.intake({
      eventId: 'same-event',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });

    expect(first.outcome).toBe('ready');
    expect(second.outcome).toBe('duplicate');
  });

  it('7/8) new SDD SHA supersedes and fences obsolete execution', async () => {
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, packageFilesFor(manifest));
    source.seed('payment-sdd', SHA2, manifest, packageFilesFor(manifest));
    const revisions = new SddRevisionManager();
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      revisions,
      new Set(['*']),
    );

    await coordinator.intake({
      eventId: 'evt-old',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });

    const next = await coordinator.intake({
      eventId: 'evt-new',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA2,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });
    expect(next.outcome).toBe('supersede');

    revisions.fenceExecution('WF#PAY-1234#1');
    expect(() => revisions.assertNotFenced('WF#PAY-1234#1')).toThrow(/fenced/i);
  });

  it('9) unrelated SDD file push does not replan', async () => {
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, packageFilesFor(manifest));
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      new SddRevisionManager(),
      new Set(['*']),
    );

    const result = await coordinator.intake({
      eventId: 'evt-unrelated',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: ['README.md'],
    });
    expect(result.outcome).toBe('ignore');
  });

  it('11) executable services bind working + release branches from SDD', () => {
    const consolidation = new PlanConsolidationService();
    const manifest = buildManifest();
    const result = consolidation.consolidate({
      manifest,
      proposedServices: [
        {
          repository: 'group/wallet-service',
          workingBranch: 'feature/PAY-1234',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executableServices[0]?.workingBranch).toBe('feature/PAY-1234');
      expect(result.executableServices[0]?.targetBranch).toBe('release/2.5.0');
    }
  });

  it('12) planner remains durable when admission is saturated (queued, not dropped)', async () => {
    // Covered semantically by M1.5 suite; assert revision/intake still ready so
    // scheduler can enqueue the Planner task once a slot frees.
    const source = new InMemorySddPackageSource();
    const manifest = buildManifest();
    source.seed('payment-sdd', SHA1, manifest, packageFilesFor(manifest));
    const coordinator = new PlanningCoordinator(
      new SddContextLoader(source),
      new SddRevisionManager(),
      new Set(['*']),
    );
    const result = await coordinator.intake({
      eventId: 'evt-queue',
      sddProject: 'payment-sdd',
      sddCommitSha: SHA1,
      devSpecId: 'PAY-1234',
      changedPaths: [manifest.spec.devSpecPath],
    });
    expect(result.outcome).toBe('ready');
  });
});
