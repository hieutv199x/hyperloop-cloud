import type {
  BranchRef,
  CommitRef,
  CreateOrUpdateMrInput,
  GitLabPort,
  MergeRequestRef,
} from './types.js';

export interface GitLabRestClientOptions {
  baseUrl: string;
  token: string;
  /** Project path allowlist; empty = allow all (dev only). */
  allowlistedProjects?: string[];
  fetchImpl?: typeof fetch;
}

/**
 * GitLab REST v4 adapter for Coding/Fix Git operations.
 * Uses project path URL-encoding; MR idempotency via workflow marker in description.
 */
export class GitLabRestClient implements GitLabPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitLabRestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  assertRepoAllowlisted(projectId: string): void {
    const list = this.options.allowlistedProjects ?? [];
    if (list.length === 0) return;
    if (!list.includes(projectId)) {
      throw new Error(`GitLab project not allowlisted: ${projectId}`);
    }
  }

  assertNotReleaseBranchPush(branch: string): void {
    if (/^release\//.test(branch)) {
      throw new Error(`Refusing push to release branch: ${branch}`);
    }
  }

  async ensureTargetBranchExists(
    projectId: string,
    targetBranch: string,
  ): Promise<BranchRef> {
    const branch = await this.getBranch(projectId, targetBranch);
    if (!branch) {
      throw new Error(`Target branch missing: ${projectId}@${targetBranch}`);
    }
    return branch;
  }

  async checkoutWorkingBranch(
    projectId: string,
    workingBranch: string,
  ): Promise<BranchRef> {
    const existing = await this.getBranch(projectId, workingBranch);
    if (existing) return existing;
    throw new Error(`Working branch missing: ${projectId}@${workingBranch}`);
  }

  async pushCommit(input: {
    projectId: string;
    branch: string;
    message: string;
    workflowMarker: string;
    files?: Record<string, string>;
  }): Promise<CommitRef> {
    this.assertNotReleaseBranchPush(input.branch);
    this.assertRepoAllowlisted(input.projectId);
    const actions = Object.entries(input.files ?? {}).map(([filePath, content]) => ({
      action: 'update' as const,
      file_path: filePath,
      content,
    }));
    const body = {
      branch: input.branch,
      commit_message: `${input.message}\n\n${input.workflowMarker}`,
      actions:
        actions.length > 0
          ? actions
          : [
              {
                action: 'create' as const,
                file_path: `.hyperloop/${input.workflowMarker}.marker`,
                content: input.workflowMarker,
              },
            ],
    };
    const res = await this.request(
      `/projects/${encodeURIComponent(input.projectId)}/repository/commits`,
      { method: 'POST', body },
    );
    const json = (await res.json()) as { id: string };
    return {
      sha: json.id,
      branch: input.branch,
      message: input.message,
      workflowMarker: input.workflowMarker,
    };
  }

  async findMrByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<MergeRequestRef | null> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/merge_requests?state=opened&per_page=50`,
    );
    const mrs = (await res.json()) as Array<{
      iid: number;
      web_url: string;
      source_branch: string;
      target_branch: string;
      description?: string;
    }>;
    const match = mrs.find((mr) => (mr.description ?? '').includes(workflowMarker));
    if (!match) return null;
    return {
      iid: match.iid,
      webUrl: match.web_url,
      sourceBranch: match.source_branch,
      targetBranch: match.target_branch,
      workflowMarker,
    };
  }

  async findCommitByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<CommitRef | null> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/repository/commits?per_page=50`,
    );
    const commits = (await res.json()) as Array<{ id: string; message: string }>;
    const match = commits.find((c) => c.message.includes(workflowMarker));
    if (!match) return null;
    return {
      sha: match.id,
      branch: '',
      message: match.message,
      workflowMarker,
    };
  }

  async createOrUpdateMr(input: CreateOrUpdateMrInput): Promise<MergeRequestRef> {
    const existing = await this.findMrByWorkflowMarker(input.projectId, input.workflowMarker);
    if (existing) {
      await this.request(
        `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${existing.iid}`,
        {
          method: 'PUT',
          body: {
            title: input.title,
            description: `${input.description}\n\n${input.workflowMarker}`,
          },
        },
      );
      return existing;
    }
    const res = await this.request(
      `/projects/${encodeURIComponent(input.projectId)}/merge_requests`,
      {
        method: 'POST',
        body: {
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.title,
          description: `${input.description}\n\n${input.workflowMarker}`,
        },
      },
    );
    const json = (await res.json()) as {
      iid: number;
      web_url: string;
      source_branch: string;
      target_branch: string;
    };
    return {
      iid: json.iid,
      webUrl: json.web_url,
      sourceBranch: json.source_branch,
      targetBranch: json.target_branch,
      workflowMarker: input.workflowMarker,
    };
  }

  private async getBranch(
    projectId: string,
    branch: string,
  ): Promise<BranchRef | null> {
    const res = await this.request(
      `/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
      { method: 'GET', okStatuses: [200, 404] },
    );
    if (res.status === 404) return null;
    const json = (await res.json()) as { name: string; commit: { id: string } };
    return { name: json.name, commitSha: json.commit.id };
  }

  private async request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      okStatuses?: number[];
    } = {},
  ): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/v4${path}`;
    const res = await this.fetchImpl(url, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'PRIVATE-TOKEN': this.options.token,
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const ok = init.okStatuses ?? [200, 201];
    if (!ok.includes(res.status)) {
      const text = await res.text();
      throw new Error(`GitLab API ${res.status} ${path}: ${text}`);
    }
    return res;
  }
}
