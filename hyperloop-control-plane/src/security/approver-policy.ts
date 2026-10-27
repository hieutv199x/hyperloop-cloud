export interface ApproverIdentity {
  entraId: string;
  displayName: string;
  email?: string;
}

/**
 * Server-side authorization for spec approval.
 * Do not trust Adaptive Card / client-provided role claims alone.
 */
export class ApproverPolicy {
  constructor(private readonly allowedEntraIds: ReadonlySet<string>) {}

  static allowAllForDev(): ApproverPolicy {
    return new ApproverPolicy(new Set(['*']));
  }

  static fromAllowlist(ids: string[]): ApproverPolicy {
    return new ApproverPolicy(new Set(ids));
  }

  isAuthorized(identity: ApproverIdentity): boolean {
    if (!identity.entraId) return false;
    if (this.allowedEntraIds.has('*')) return true;
    return this.allowedEntraIds.has(identity.entraId);
  }
}
