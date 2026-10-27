import type { GitLabSDDReader, SddPackageSnapshot } from './sdd-reader.js';

export interface GitLabRestSddReaderOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches pinned SDD files at ref=<commitSha> via GitLab repository files API.
 */
export class GitLabRestSddReader implements GitLabSDDReader {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitLabRestSddReaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchPinnedPackage(input: {
    sddProject: string;
    sddCommitSha: string;
    paths?: string[];
  }): Promise<SddPackageSnapshot> {
    if (!/^[a-f0-9]{40}$/i.test(input.sddCommitSha)) {
      throw new Error(`Invalid pinned SDD commit SHA: ${input.sddCommitSha}`);
    }
    const paths = input.paths ?? [];
    if (paths.length === 0) {
      throw new Error(
        'GitLabRestSddReader requires explicit paths (no full-tree archive in P7)',
      );
    }
    const files: Record<string, string> = {};
    for (const filePath of paths) {
      files[filePath] = await this.fetchFile(
        input.sddProject,
        filePath,
        input.sddCommitSha,
      );
    }
    return {
      sddProject: input.sddProject,
      sddCommitSha: input.sddCommitSha,
      files,
    };
  }

  private async fetchFile(
    projectId: string,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const encodedPath = encodeURIComponent(filePath);
    const url =
      `${this.options.baseUrl.replace(/\/$/, '')}/api/v4/projects/` +
      `${encodeURIComponent(projectId)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const res = await this.fetchImpl(url, {
      headers: { 'PRIVATE-TOKEN': this.options.token },
    });
    if (!res.ok) {
      throw new Error(
        `GitLab file ${projectId}@${ref}:${filePath} → HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as { content: string; encoding: string };
    if (json.encoding === 'base64') {
      return Buffer.from(json.content, 'base64').toString('utf8');
    }
    return json.content;
  }
}
