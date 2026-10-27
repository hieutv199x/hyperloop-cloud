import { validate } from '@hyperloop/contracts';
import type {
  PinnedSddContext,
  SddValidationIssue,
  SddValidationResult,
} from './types.js';

const PATH_ESCAPE = /(^|\/)\.\.(\/|$)/;

export class SddCompletenessValidator {
  validate(context: PinnedSddContext, allowedRepositories: ReadonlySet<string>): SddValidationResult {
    const issues: SddValidationIssue[] = [];

    const schema = validate('sdd-manifest', context.manifest);
    if (!schema.valid) {
      issues.push({
        code: 'HL_SDD_MANIFEST_INVALID',
        message: 'SDD manifest failed schema validation',
      });
      return { ok: false, issues };
    }

    if (!/^[a-f0-9]{40}$/i.test(context.sddCommitSha)) {
      issues.push({
        code: 'HL_SDD_INVALID_COMMIT_SHA',
        message: 'Pinned SDD commit SHA must be a 40-char hex from GitLab webhook',
      });
    }

    const requiredPaths = [
      context.manifest.spec.devSpecPath,
      ...context.manifest.spec.requirements,
      ...context.manifest.spec.designs,
      ...context.manifest.spec.acceptanceCriteria,
      ...(context.manifest.spec.analysis ?? []),
    ];

    for (const path of requiredPaths) {
      if (PATH_ESCAPE.test(path) || path.startsWith('/') || path.includes('\\')) {
        issues.push({
          code: 'HL_SDD_PATH_ESCAPE',
          message: `Illegal document path: ${path}`,
          path,
        });
        continue;
      }
      if (!(path in context.packageFiles.files)) {
        issues.push({
          code: 'HL_SDD_MISSING_DOCUMENT',
          message: `Missing required SDD document: ${path}`,
          path,
        });
      }
    }

    const serviceNames = new Set(context.manifest.spec.services.map((s) => s.name));
    for (const service of context.manifest.spec.services) {
      if (
        !allowedRepositories.has(service.repository) &&
        !allowedRepositories.has('*')
      ) {
        issues.push({
          code: 'HL_SDD_UNKNOWN_REPOSITORY',
          message: `Repository not allowlisted: ${service.repository}`,
          path: service.repository,
        });
      }
      if (!/^release\/\d+\.\d+\.\d+$/.test(service.targetBranch)) {
        issues.push({
          code: 'HL_SDD_INVALID_TARGET_BRANCH',
          message: `Invalid targetBranch for ${service.name}: ${service.targetBranch}`,
          path: service.name,
        });
      }
      if (!service.workingBranch || service.workingBranch.startsWith('release/')) {
        issues.push({
          code: 'HL_SDD_INVALID_WORKING_BRANCH',
          message: `Invalid workingBranch for ${service.name}: ${service.workingBranch}`,
          path: service.name,
        });
      }
      for (const dep of service.dependsOn) {
        if (!serviceNames.has(dep)) {
          issues.push({
            code: 'HL_SDD_UNKNOWN_DEPENDENCY',
            message: `Service ${service.name} depends on unknown service ${dep}`,
            path: service.name,
          });
        }
      }
    }

    return { ok: issues.length === 0, issues };
  }
}
