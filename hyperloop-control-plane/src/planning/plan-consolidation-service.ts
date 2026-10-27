import type { PlanServiceNode } from '../domain/types.js';
import type { SddManifest, SddValidationIssue, SddValidationResult } from '../sdd/types.js';

/**
 * Ensures Planner output stays within declared SDD scope.
 * Planner may flag extras, but cannot add them to executable scope.
 */
export class PlanConsolidationService {
  consolidate(input: {
    manifest: SddManifest;
    proposedServices: PlanServiceNode[];
    flaggedExtraRepositories?: string[];
  }): SddValidationResult & { executableServices: PlanServiceNode[] } {
    const issues: SddValidationIssue[] = [];
    const allowedRepos = new Set(input.manifest.spec.services.map((s) => s.repository));

    const executableServices = input.proposedServices.filter((service) => {
      if (!allowedRepos.has(service.repository)) {
        issues.push({
          code: 'HL_SDD_SCOPE_VIOLATION',
          message: `Planner proposed undeclared repository ${service.repository}; blocked from executable scope`,
          path: service.repository,
        });
        return false;
      }
      return true;
    });

    for (const extra of input.flaggedExtraRepositories ?? []) {
      if (!allowedRepos.has(extra)) {
        issues.push({
          code: 'HL_SDD_FLAGGED_EXTRA_SERVICE',
          message: `Planner flagged potentially affected undeclared service ${extra}; requires SDD revision`,
          path: extra,
        });
      }
    }

    // Scope violations are hard failures for executable plan acceptance.
    const hardFailure = issues.some((i) => i.code === 'HL_SDD_SCOPE_VIOLATION');
    return {
      ok: !hardFailure && executableServices.length > 0,
      issues,
      executableServices,
    };
  }
}
