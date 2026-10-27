import type { GitLabSDDReader } from '@hyperloop/integrations';
import type { SddPackageSource } from './sdd-context-loader.js';
import type { SddManifest, SddPackageFiles } from './types.js';

const MANIFEST_CANDIDATES = ['hyperloop.sdd.json', 'hyperloop.yaml'] as const;

/**
 * Adapts integrations GitLabSDDReader into control-plane SddPackageSource.
 */
export class GitLabSddPackageSource implements SddPackageSource {
  constructor(private readonly reader: GitLabSDDReader) {}

  async fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
  }): Promise<{ manifest: SddManifest; packageFiles: SddPackageFiles }> {
    const tip = await this.reader.fetchPinnedPackage({
      sddProject: input.sddProject,
      sddCommitSha: input.sddCommitSha,
    });

    const manifestPath = MANIFEST_CANDIDATES.find((p) => p in tip.files);
    if (!manifestPath) {
      throw new Error(
        `Pinned SDD missing hyperloop.sdd.json / hyperloop.yaml at ${input.sddCommitSha}`,
      );
    }

    const manifest = JSON.parse(tip.files[manifestPath]!) as SddManifest;

    return {
      manifest,
      packageFiles: { files: tip.files },
    };
  }
}
