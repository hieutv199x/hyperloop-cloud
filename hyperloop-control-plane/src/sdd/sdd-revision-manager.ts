export interface SddRevisionIdentity {
  sddProjectId: string;
  devSpecPath: string;
  pinnedCommitSha: string;
  devSpecId: string;
}

export interface RevisionDecision {
  action: 'create' | 'supersede' | 'ignore_unrelated' | 'duplicate';
  reason: string;
}

/**
 * Handles repeated SDD pushes: dedupe, supersede stale plans, ignore unrelated paths.
 */
export class SddRevisionManager {
  private readonly seenDeliveries = new Set<string>();
  private readonly latestByDevSpec = new Map<string, SddRevisionIdentity>();
  private readonly fencedExecutions = new Set<string>();

  lineageKey(identity: Pick<SddRevisionIdentity, 'sddProjectId' | 'devSpecId'>): string {
    return `${identity.sddProjectId}::${identity.devSpecId}`;
  }

  revisionKey(identity: SddRevisionIdentity): string {
    return `${identity.sddProjectId}::${identity.devSpecPath}::${identity.pinnedCommitSha}`;
  }

  recordDelivery(eventId: string): 'new' | 'duplicate' {
    if (this.seenDeliveries.has(eventId)) return 'duplicate';
    this.seenDeliveries.add(eventId);
    return 'new';
  }

  evaluatePush(input: {
    eventId: string;
    identity: SddRevisionIdentity;
    changedPaths: string[];
  }): RevisionDecision {
    if (this.recordDelivery(input.eventId) === 'duplicate') {
      return { action: 'duplicate', reason: 'Duplicate webhook delivery' };
    }

    const relevant = input.changedPaths.some(
      (path) =>
        path === input.identity.devSpecPath ||
        path === 'hyperloop.yaml' ||
        path.startsWith('02-requirements/') ||
        path.startsWith('03-design/') ||
        path.startsWith('04-development/'),
    );
    if (!relevant) {
      return { action: 'ignore_unrelated', reason: 'No relevant SDD planning paths changed' };
    }

    const lineage = this.lineageKey(input.identity);
    const previous = this.latestByDevSpec.get(lineage);
    this.latestByDevSpec.set(lineage, input.identity);

    if (previous && previous.pinnedCommitSha !== input.identity.pinnedCommitSha) {
      return {
        action: 'supersede',
        reason: `New SDD SHA ${input.identity.pinnedCommitSha} supersedes ${previous.pinnedCommitSha}`,
      };
    }

    return { action: 'create', reason: 'New SDD revision' };
  }

  fenceExecution(workflowId: string): void {
    this.fencedExecutions.add(workflowId);
  }

  isFenced(workflowId: string): boolean {
    return this.fencedExecutions.has(workflowId);
  }

  assertNotFenced(workflowId: string): void {
    if (this.isFenced(workflowId)) {
      throw new Error(`Execution fenced for workflow ${workflowId}; further push denied`);
    }
  }
}
