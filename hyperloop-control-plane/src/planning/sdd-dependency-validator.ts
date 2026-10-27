import { topologicalSort } from '../domain/dag.js';
import type { SddServiceDeclaration } from '../sdd/types.js';
import type { SddValidationIssue, SddValidationResult } from '../sdd/types.js';

export class SddDependencyValidator {
  validate(services: SddServiceDeclaration[]): SddValidationResult {
    const issues: SddValidationIssue[] = [];
    const names = new Set(services.map((s) => s.name));

    for (const service of services) {
      for (const dep of service.dependsOn) {
        if (!names.has(dep)) {
          issues.push({
            code: 'HL_SDD_UNKNOWN_DEPENDENCY',
            message: `Unknown dependency ${dep} referenced by ${service.name}`,
          });
        }
      }
    }

    try {
      topologicalSort({
        nodes: services.map((s) => s.name),
        edges: services.flatMap((s) =>
          s.dependsOn.map((from) => ({ from, to: s.name })),
        ),
      });
    } catch (error) {
      issues.push({
        code: 'HL_SDD_DEPENDENCY_CYCLE',
        message: error instanceof Error ? error.message : 'Dependency cycle detected',
      });
    }

    return { ok: issues.length === 0, issues };
  }
}
