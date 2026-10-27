import { createHash } from 'node:crypto';
import type {
  BranchRef,
  CommitRef,
  CreateOrUpdateMrInput,
  GitLabPort,
  MergeRequestRef,
} from './types.js';

export type {
  CreateOrUpdateMrInput,
  MergeRequestRef,
  BranchRef,
  CommitRef,
  GitLabPort,
} from './types.js';

/**
 * In-memory GitLab for tests and local vertical slices.
 * Agents must never push directly to protected release branches.
 */
export class InMemoryGitLabClient implements GitLabPort {
  private mrSeq = 0;
  readonly branches = new Map<string, BranchRef>();
  readonly commits: CommitRef[] = [];
  readonly mergeRequests: MergeRequestRef[] = [];
  readonly pushCountByMarker = new Map<string, number>();

  constructor(
    private readonly allowedProjects: ReadonlySet<string>,
    seedBranches: Array<{ projectId: string; name: string; commitSha?: string }> = [],
  ) {
    for (const branch of seedBranches) {
      this.branches.set(this.key(branch.projectId, branch.name), {
        name: branch.name,
        commitSha: branch.commitSha ?? this.sha(`seed:${branch.projectId}:${branch.name}`),
      });
    }
  }

  assertRepoAllowlisted(projectId: string): void {
    if (!this.allowedProjects.has(projectId) && !this.allowedProjects.has('*')) {
      throw new Error(`Repository not allowlisted: ${projectId}`);
    }
  }

  assertNotReleaseBranchPush(branch: string): void {
    if (branch.startsWith('release/')) {
      throw new Error('Direct push to release branch is forbidden; open an MR instead');
    }
  }

  async ensureTargetBranchExists(
    projectId: string,
    targetBranch: string,
  ): Promise<BranchRef> {
    this.assertRepoAllowlisted(projectId);
    if (!/^release\/\d+\.\d+\.\d+$/.test(targetBranch)) {
      throw new Error(`Invalid release target branch: ${targetBranch}`);
    }
    const existing = this.branches.get(this.key(projectId, targetBranch));
    if (!existing) {
      throw new Error(`Target branch does not exist: ${projectId}@${targetBranch}`);
    }
    return existing;
  }

  async checkoutWorkingBranch(
    projectId: string,
    workingBranch: string,
  ): Promise<BranchRef> {
    this.assertRepoAllowlisted(projectId);
    this.assertNotReleaseBranchPush(workingBranch);
    const key = this.key(projectId, workingBranch);
    const existing = this.branches.get(key);
    if (existing) return existing;

    const created: BranchRef = {
      name: workingBranch,
      commitSha: this.sha(`create:${projectId}:${workingBranch}`),
    };
    this.branches.set(key, created);
    return created;
  }

  async pushCommit(input: {
    projectId: string;
    branch: string;
    message: string;
    workflowMarker: string;
    files?: Record<string, string>;
  }): Promise<CommitRef> {
    this.assertRepoAllowlisted(input.projectId);
    this.assertNotReleaseBranchPush(input.branch);
    await this.checkoutWorkingBranch(input.projectId, input.branch);

    const sha = this.sha(
      `${input.projectId}:${input.branch}:${input.workflowMarker}:${this.commits.length}:${JSON.stringify(input.files ?? {})}`,
    );
    const commit: CommitRef = {
      sha,
      branch: input.branch,
      message: `${input.message}\n\n${input.workflowMarker}`,
      workflowMarker: input.workflowMarker,
    };
    this.commits.push(commit);
    this.branches.set(this.key(input.projectId, input.branch), {
      name: input.branch,
      commitSha: sha,
    });
    this.pushCountByMarker.set(
      input.workflowMarker,
      (this.pushCountByMarker.get(input.workflowMarker) ?? 0) + 1,
    );
    return commit;
  }

  async findMrByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<MergeRequestRef | null> {
    void projectId;
    return this.mergeRequests.find((mr) => mr.workflowMarker === workflowMarker) ?? null;
  }

  async findCommitByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<CommitRef | null> {
    void projectId;
    return (
      [...this.commits].reverse().find((c) => c.workflowMarker === workflowMarker) ?? null
    );
  }

  async createOrUpdateMr(input: CreateOrUpdateMrInput): Promise<MergeRequestRef> {
    this.assertRepoAllowlisted(input.projectId);
    await this.ensureTargetBranchExists(input.projectId, input.targetBranch);
    this.assertNotReleaseBranchPush(input.sourceBranch);

    const existing = await this.findMrByWorkflowMarker(
      input.projectId,
      input.workflowMarker,
    );
    if (existing) {
      existing.sourceBranch = input.sourceBranch;
      existing.targetBranch = input.targetBranch;
      return existing;
    }

    this.mrSeq += 1;
    const mr: MergeRequestRef = {
      iid: this.mrSeq,
      webUrl: `https://gitlab.example/${input.projectId}/-/merge_requests/${this.mrSeq}`,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      workflowMarker: input.workflowMarker,
    };
    this.mergeRequests.push(mr);
    return mr;
  }

  /**
   * Crash-recovery helper: if commit with marker exists but MR missing, recreate MR only.
   */
  async reconcileAfterPush(input: CreateOrUpdateMrInput): Promise<{
    commit: CommitRef | null;
    mr: MergeRequestRef;
  }> {
    const commit =
      [...this.commits]
        .reverse()
        .find(
          (c) => c.workflowMarker === input.workflowMarker && c.branch === input.sourceBranch,
        ) ?? null;
    const mr = await this.createOrUpdateMr(input);
    return { commit, mr };
  }

  private key(projectId: string, branch: string): string {
    return `${projectId}::${branch}`;
  }

  private sha(material: string): string {
    return createHash('sha1').update(material).digest('hex');
  }
}

/** Alias kept for earlier imports. */
export class GitLabClient extends InMemoryGitLabClient {
  constructor(baseUrl: string, token: string, allowedProjects: string[] = ['*']) {
    void baseUrl;
    void token;
    super(new Set(allowedProjects));
  }
}
