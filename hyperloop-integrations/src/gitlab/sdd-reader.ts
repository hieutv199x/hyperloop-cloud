/**
 * Fetches a pinned *-sdd package at an exact GitLab commit SHA.
 * Callers must supply the SHA from a verified webhook/commit lookup —
 * never trust a mutable tip branch.
 */
export interface SddPackageSnapshot {
  sddProject: string;
  sddCommitSha: string;
  /** Relative path -> UTF-8 file contents. */
  files: Record<string, string>;
}

export interface GitLabSDDReader {
  fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
    /**
     * Paths to materialize. Omit or pass empty to return the full pinned tree
     * (in-memory / archive fetch). Production GitLab API callers should pass
     * explicit paths after reading the manifest.
     */
    paths?: string[];
  }): Promise<SddPackageSnapshot>;
}

export class InMemoryGitLabSDDReader implements GitLabSDDReader {
  private readonly packages = new Map<string, Record<string, string>>();

  seed(sddProject: string, sddCommitSha: string, files: Record<string, string>): void {
    this.packages.set(`${sddProject}@${sddCommitSha}`, { ...files });
  }

  async fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
    paths?: string[];
  }): Promise<SddPackageSnapshot> {
    if (!/^[a-f0-9]{40}$/i.test(input.sddCommitSha)) {
      throw new Error(`Invalid pinned SDD commit SHA: ${input.sddCommitSha}`);
    }
    const all = this.packages.get(`${input.sddProject}@${input.sddCommitSha}`);
    if (!all) {
      throw new Error(
        `Pinned SDD package not found: ${input.sddProject}@${input.sddCommitSha}`,
      );
    }
    if (!input.paths || input.paths.length === 0) {
      return {
        sddProject: input.sddProject,
        sddCommitSha: input.sddCommitSha,
        files: { ...all },
      };
    }
    const files: Record<string, string> = {};
    for (const path of input.paths) {
      if (!(path in all)) {
        throw new Error(
          `Missing path in pinned SDD ${input.sddProject}@${input.sddCommitSha}: ${path}`,
        );
      }
      files[path] = all[path]!;
    }
    return {
      sddProject: input.sddProject,
      sddCommitSha: input.sddCommitSha,
      files,
    };
  }
}
