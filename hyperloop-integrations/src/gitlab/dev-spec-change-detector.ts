const RELEVANT_PREFIXES = [
  '02-requirements/',
  '03-design/',
  '04-development/',
] as const;

export interface DevSpecChangeInput {
  eventId: string;
  sddProject: string;
  sddCommitSha: string;
  changedPaths: string[];
  /** Optional explicit DEV-Spec path for relevance matching. */
  devSpecPath?: string;
}

export type DevSpecChangeDecision =
  | { action: 'process'; reason: string }
  | { action: 'ignore'; reason: string }
  | { action: 'duplicate'; reason: string };

/**
 * Filters GitLab *-sdd push events: path relevance + delivery dedupe.
 * Does not fetch content — pairs with GitLabSDDReader for pinned loads.
 */
export class DevSpecChangeDetector {
  private readonly seenDeliveries = new Set<string>();

  evaluate(input: DevSpecChangeInput): DevSpecChangeDecision {
    if (this.seenDeliveries.has(input.eventId)) {
      return { action: 'duplicate', reason: 'Duplicate webhook delivery' };
    }
    this.seenDeliveries.add(input.eventId);

    if (!/^[a-f0-9]{40}$/i.test(input.sddCommitSha)) {
      return { action: 'ignore', reason: 'Missing or invalid pinned commit SHA' };
    }

    const relevant = input.changedPaths.some((path) => this.isRelevantPath(path, input.devSpecPath));
    if (!relevant) {
      return { action: 'ignore', reason: 'No relevant SDD planning paths changed' };
    }

    return { action: 'process', reason: 'Relevant SDD planning paths changed' };
  }

  isRelevantPath(path: string, devSpecPath?: string): boolean {
    if (path === 'hyperloop.yaml' || path === 'hyperloop.sdd.json') return true;
    if (devSpecPath && path === devSpecPath) return true;
    return RELEVANT_PREFIXES.some((prefix) => path.startsWith(prefix));
  }
}
