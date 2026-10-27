import { PlanConsolidationService } from './plan-consolidation-service.js';
import { SddDependencyValidator } from './sdd-dependency-validator.js';
import { SddCompletenessValidator } from '../sdd/sdd-completeness-validator.js';
import { SddContextLoader } from '../sdd/sdd-context-loader.js';
import { SddRevisionManager } from '../sdd/sdd-revision-manager.js';
import { SddServiceResolver } from '../sdd/sdd-service-resolver.js';
import type { PinnedSddContext, SddValidationIssue } from '../sdd/types.js';
import type { PlanServiceNode } from '../domain/types.js';

export type PlanningIntakeResult =
  | {
      outcome: 'ready';
      context: PinnedSddContext;
      planServices: PlanServiceNode[];
    }
  | {
      outcome: 'needs_clarification';
      issues: SddValidationIssue[];
    }
  | {
      outcome: 'ignore';
      reason: string;
    }
  | {
      outcome: 'duplicate';
      reason: string;
    }
  | {
      outcome: 'supersede';
      context: PinnedSddContext;
      planServices: PlanServiceNode[];
      reason: string;
    };

export class PlanningCoordinator {
  private readonly completeness = new SddCompletenessValidator();
  private readonly resolver = new SddServiceResolver();
  private readonly dependencies = new SddDependencyValidator();
  private readonly consolidation = new PlanConsolidationService();

  constructor(
    private readonly loader: SddContextLoader,
    private readonly revisions: SddRevisionManager,
    private readonly allowedRepositories: ReadonlySet<string>,
  ) {}

  async intake(input: {
    eventId: string;
    sddProject: string;
    sddCommitSha: string;
    devSpecId: string;
    changedPaths: string[];
  }): Promise<PlanningIntakeResult> {
    const context = await this.loader.load({
      sddProject: input.sddProject,
      sddCommitSha: input.sddCommitSha,
    });

    const revision = this.revisions.evaluatePush({
      eventId: input.eventId,
      changedPaths: input.changedPaths,
      identity: {
        sddProjectId: input.sddProject,
        devSpecPath: context.devSpecPath,
        pinnedCommitSha: input.sddCommitSha,
        devSpecId: input.devSpecId,
      },
    });

    if (revision.action === 'duplicate') {
      return { outcome: 'duplicate', reason: revision.reason };
    }
    if (revision.action === 'ignore_unrelated') {
      return { outcome: 'ignore', reason: revision.reason };
    }

    const complete = this.completeness.validate(context, this.allowedRepositories);
    if (!complete.ok) {
      return { outcome: 'needs_clarification', issues: complete.issues };
    }

    const services = this.resolver.resolve(context.manifest);
    const deps = this.dependencies.validate(services);
    if (!deps.ok) {
      return { outcome: 'needs_clarification', issues: deps.issues };
    }

    const planServices = this.resolver.toPlanServices(context.manifest);
    const consolidated = this.consolidation.consolidate({
      manifest: context.manifest,
      proposedServices: planServices,
    });
    if (!consolidated.ok) {
      return { outcome: 'needs_clarification', issues: consolidated.issues };
    }

    if (revision.action === 'supersede') {
      return {
        outcome: 'supersede',
        context,
        planServices: consolidated.executableServices,
        reason: revision.reason,
      };
    }

    return {
      outcome: 'ready',
      context,
      planServices: consolidated.executableServices,
    };
  }

  consolidatePlannerProposal(
    context: PinnedSddContext,
    proposedServices: PlanServiceNode[],
    flaggedExtraRepositories?: string[],
  ) {
    return this.consolidation.consolidate({
      manifest: context.manifest,
      proposedServices,
      flaggedExtraRepositories,
    });
  }
}
