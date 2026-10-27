import type { PinnedSddContext, SddManifest, SddPackageFiles } from './types.js';

/**
 * Loads a pinned SDD package. Production uses GitLab fetch at commit SHA;
 * tests inject an in-memory package.
 */
export interface SddPackageSource {
  fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
  }): Promise<{ manifest: SddManifest; packageFiles: SddPackageFiles }>;
}

export class InMemorySddPackageSource implements SddPackageSource {
  constructor(
    private readonly packages = new Map<
      string,
      { manifest: SddManifest; packageFiles: SddPackageFiles }
    >(),
  ) {}

  seed(
    sddProject: string,
    sddCommitSha: string,
    manifest: SddManifest,
    packageFiles: SddPackageFiles,
  ): void {
    this.packages.set(`${sddProject}@${sddCommitSha}`, { manifest, packageFiles });
  }

  async fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
  }): Promise<{ manifest: SddManifest; packageFiles: SddPackageFiles }> {
    const found = this.packages.get(`${input.sddProject}@${input.sddCommitSha}`);
    if (!found) {
      throw new Error(
        `Pinned SDD package not found: ${input.sddProject}@${input.sddCommitSha}`,
      );
    }
    return found;
  }
}

export class SddContextLoader {
  constructor(private readonly source: SddPackageSource) {}

  async load(input: {
    sddProject: string;
    sddCommitSha: string;
  }): Promise<PinnedSddContext> {
    const { manifest, packageFiles } = await this.source.fetchPinnedPackage(input);
    return {
      sddProject: input.sddProject,
      sddCommitSha: input.sddCommitSha,
      devSpecPath: manifest.spec.devSpecPath,
      manifest,
      packageFiles,
    };
  }
}
