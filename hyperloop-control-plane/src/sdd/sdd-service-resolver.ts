import type { SddManifest, SddServiceDeclaration } from './types.js';

/**
 * Deterministic resolver: executable targets come only from SDD declarations.
 * No external service catalog / Graphify / Jira lookup.
 */
export class SddServiceResolver {
  resolve(manifest: SddManifest): SddServiceDeclaration[] {
    return [...manifest.spec.services].sort((a, b) => a.name.localeCompare(b.name));
  }

  toPlanServices(manifest: SddManifest) {
    const byName = new Map(manifest.spec.services.map((s) => [s.name, s]));
    return manifest.spec.services.map((service) => ({
      repository: service.repository,
      workingBranch: service.workingBranch,
      targetBranch: service.targetBranch,
      dependsOn: service.dependsOn.map((depName) => {
        const dep = byName.get(depName);
        if (!dep) {
          throw new Error(`Unresolved dependency name: ${depName}`);
        }
        return dep.repository;
      }),
    }));
  }
}
