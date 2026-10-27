export interface CreateOrUpdateMrInput {
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  workflowMarker: string;
}

export interface MergeRequestRef {
  iid: number;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  workflowMarker: string;
}

export interface BranchRef {
  name: string;
  commitSha: string;
}

export interface CommitRef {
  sha: string;
  branch: string;
  message: string;
  workflowMarker?: string;
}

export interface GitLabPort {
  assertRepoAllowlisted(projectId: string): void;
  assertNotReleaseBranchPush(branch: string): void;
  ensureTargetBranchExists(projectId: string, targetBranch: string): Promise<BranchRef>;
  checkoutWorkingBranch(projectId: string, workingBranch: string): Promise<BranchRef>;
  pushCommit(input: {
    projectId: string;
    branch: string;
    message: string;
    workflowMarker: string;
    files?: Record<string, string>;
  }): Promise<CommitRef>;
  findMrByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<MergeRequestRef | null>;
  findCommitByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<CommitRef | null>;
  createOrUpdateMr(input: CreateOrUpdateMrInput): Promise<MergeRequestRef>;
}
