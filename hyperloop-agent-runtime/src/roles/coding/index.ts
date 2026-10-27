import type { ArtifactStore } from '../../artifacts/types.js';
import { buildArtifactUri } from '../../artifacts/types.js';
import type { AgentInput, AgentOutput } from '../../runner/run-agent.js';
import { invokeKiroCoding } from '../../runner/kiro-coding.js';
import type { AuthorizePushClient } from '../../security/authorize-push.js';

export interface CodingGitLabPort {
  assertRepoAllowlisted(projectId: string): void;
  ensureTargetBranchExists(
    projectId: string,
    targetBranch: string,
  ): Promise<{ commitSha?: string } | unknown>;
  checkoutWorkingBranch(
    projectId: string,
    workingBranch: string,
  ): Promise<{ commitSha?: string } | unknown>;
  pushCommit(input: {
    projectId: string;
    branch: string;
    message: string;
    workflowMarker: string;
    files?: Record<string, string>;
  }): Promise<{ sha: string }>;
  findMrByWorkflowMarker(
    projectId: string,
    workflowMarker: string,
  ): Promise<{ iid: number; webUrl: string } | null>;
  findCommitByWorkflowMarker?(
    projectId: string,
    workflowMarker: string,
  ): Promise<{ sha: string; branch: string } | null>;
  createOrUpdateMr(input: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    workflowMarker: string;
  }): Promise<{ iid: number; webUrl: string }>;
  reconcileAfterPush?(input: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    workflowMarker: string;
  }): Promise<{
    commit: { sha: string } | null;
    mr: { iid: number; webUrl: string };
  }>;
}

export interface CodingInput extends AgentInput {
  stage: 'coding';
  repository: string;
  workingBranch: string;
  targetBranch: string;
  approvedSpecHash: string;
  expectedApprovedSpecHash: string;
  artifactsBucket: string;
  artifactStore: ArtifactStore;
  gitlab: CodingGitLabPort;
  /** v1.3: expected HEAD SHA of working branch before mutation. */
  expectedBaseSha?: string;
  executionId?: string;
  fenceToken?: string;
  /** Prefer Control Plane authorize-push; falls back to assertPushAllowed. */
  authorizePush?: AuthorizePushClient;
  /**
   * Legacy fencing hook. Throw to deny further mutation when the execution is obsolete.
   */
  assertPushAllowed?: () => void;
  /** Simulate crash after git push but before MR/checkpoint. */
  simulateCrashAfterPush?: boolean;
}

export function workflowMarker(workflowId: string, repository: string): string {
  return `hyperloop-workflow:${workflowId}:repo:${repository}`;
}

export async function runCoding(input: CodingInput | AgentInput): Promise<AgentOutput> {
  if (!isCodingInput(input)) {
    return {
      jobId: input.jobId,
      stage: 'coding',
      exitStatus: 'FAILED',
      message: 'Coding requires repository, branches, approvedSpecHash, gitlab, artifactStore',
      outputArtifactUris: [],
      errorCode: 'HL_CODING_INVALID_INPUT',
    };
  }

  if (input.approvedSpecHash !== input.expectedApprovedSpecHash) {
    return {
      jobId: input.jobId,
      stage: 'coding',
      exitStatus: 'FAILED',
      message: 'approvedSpecHash does not match expected approved hash',
      outputArtifactUris: [],
      errorCode: 'HL_CODING_SPEC_HASH_MISMATCH',
    };
  }

  if (!/^release\/\d+\.\d+\.\d+$/.test(input.targetBranch)) {
    return {
      jobId: input.jobId,
      stage: 'coding',
      exitStatus: 'FAILED',
      message: `Invalid targetBranch: ${input.targetBranch}`,
      outputArtifactUris: [],
      errorCode: 'HL_CODING_INVALID_TARGET_BRANCH',
    };
  }

  const marker = workflowMarker(input.workflowId, input.repository);

  try {
    input.gitlab.assertRepoAllowlisted(input.repository);
    await input.gitlab.ensureTargetBranchExists(input.repository, input.targetBranch);
    const checkedOut = await input.gitlab.checkoutWorkingBranch(
      input.repository,
      input.workingBranch,
    );
    const headSha =
      checkedOut && typeof checkedOut === 'object' && 'commitSha' in checkedOut
        ? String((checkedOut as { commitSha?: string }).commitSha ?? '')
        : '';

    if (input.expectedBaseSha && headSha && headSha !== input.expectedBaseSha) {
      return {
        jobId: input.jobId,
        stage: 'coding',
        exitStatus: 'FAILED',
        message: `Working branch HEAD ${headSha} does not match expectedBaseSha ${input.expectedBaseSha}`,
        outputArtifactUris: [],
        errorCode: 'HL_CODING_BASE_SHA_DRIFT',
        branch: input.workingBranch,
      };
    }

    // Idempotent recovery: if prior attempt already pushed (and maybe MR'd), reuse.
    const existingCommit = input.gitlab.findCommitByWorkflowMarker
      ? await input.gitlab.findCommitByWorkflowMarker(input.repository, marker)
      : null;
    if (existingCommit && input.gitlab.reconcileAfterPush) {
      const recovered = await input.gitlab.reconcileAfterPush({
        projectId: input.repository,
        sourceBranch: input.workingBranch,
        targetBranch: input.targetBranch,
        title: `${input.workflowId} ${input.repository}`,
        description: marker,
        workflowMarker: marker,
      });
      return await persistCodingResult(input, {
        commitSha: recovered.commit?.sha ?? existingCommit.sha,
        mrIid: recovered.mr.iid,
        branch: input.workingBranch,
        message: 'Recovered existing push/MR after crash',
      });
    }

    const generated = await invokeKiroCoding({
      workflowId: input.workflowId,
      repository: input.repository,
      approvedSpecHash: input.approvedSpecHash,
      workingBranch: input.workingBranch,
    });

    // Re-check HEAD immediately before push (race with concurrent commits).
    const beforePush = await input.gitlab.checkoutWorkingBranch(
      input.repository,
      input.workingBranch,
    );
    const beforePushSha =
      beforePush && typeof beforePush === 'object' && 'commitSha' in beforePush
        ? String((beforePush as { commitSha?: string }).commitSha ?? '')
        : '';
    if (input.expectedBaseSha && beforePushSha && beforePushSha !== input.expectedBaseSha) {
      return {
        jobId: input.jobId,
        stage: 'coding',
        exitStatus: 'FAILED',
        message: `Pre-push HEAD ${beforePushSha} drifted from expectedBaseSha ${input.expectedBaseSha}`,
        outputArtifactUris: [],
        errorCode: 'HL_CODING_BASE_SHA_DRIFT',
        branch: input.workingBranch,
      };
    }

    const fenceDenied = await enforceFence(input);
    if (fenceDenied) return fenceDenied;

    const commit = await input.gitlab.pushCommit({
      projectId: input.repository,
      branch: input.workingBranch,
      message: `feat: ${input.workflowId} ${input.repository}`,
      workflowMarker: marker,
      files: generated.files,
    });

    if (input.simulateCrashAfterPush) {
      throw new Error('Simulated crash after git push before MR/checkpoint');
    }

    const mr = await input.gitlab.createOrUpdateMr({
      projectId: input.repository,
      sourceBranch: input.workingBranch,
      targetBranch: input.targetBranch,
      title: `${input.workflowId} ${input.repository}`,
      description: `${generated.summary}\n\n${marker}`,
      workflowMarker: marker,
    });

    return await persistCodingResult(input, {
      commitSha: commit.sha,
      mrIid: mr.iid,
      branch: input.workingBranch,
      message: generated.summary,
    });
  } catch (error) {
    // Crash after push: reconcile via workflow marker — do not create duplicate commits/MRs
    // when caller retries without simulateCrashAfterPush.
    if (
      error instanceof Error &&
      error.message.includes('Simulated crash after git push') &&
      input.gitlab.reconcileAfterPush
    ) {
      // Surface failure for this attempt; durable git state remains for retry.
      return {
        jobId: input.jobId,
        stage: 'coding',
        exitStatus: 'FAILED',
        message: error.message,
        outputArtifactUris: [],
        errorCode: 'HL_CODING_CRASH_AFTER_PUSH',
        branch: input.workingBranch,
      };
    }

    return {
      jobId: input.jobId,
      stage: 'coding',
      exitStatus: 'FAILED',
      message: error instanceof Error ? error.message : 'Coding failed',
      outputArtifactUris: [],
      errorCode: 'HL_CODING_FAILED',
    };
  }
}

async function enforceFence(input: CodingInput): Promise<AgentOutput | null> {
  if (input.authorizePush && input.executionId && input.fenceToken) {
    const decision = await input.authorizePush({
      executionId: input.executionId,
      fenceToken: input.fenceToken,
    });
    if (decision === 'denied') {
      return {
        jobId: input.jobId,
        stage: 'coding',
        exitStatus: 'FAILED',
        message: `Execution fenced for ${input.executionId}; further push denied`,
        outputArtifactUris: [],
        errorCode: 'HL_CODING_EXECUTION_FENCED',
        branch: input.workingBranch,
      };
    }
    return null;
  }

  try {
    input.assertPushAllowed?.();
    return null;
  } catch (error) {
    return {
      jobId: input.jobId,
      stage: 'coding',
      exitStatus: 'FAILED',
      message: error instanceof Error ? error.message : 'Push fenced',
      outputArtifactUris: [],
      errorCode: 'HL_CODING_EXECUTION_FENCED',
      branch: input.workingBranch,
    };
  }
}

async function persistCodingResult(
  input: CodingInput,
  result: { commitSha: string; mrIid: number; branch: string; message: string },
): Promise<AgentOutput> {
  const safeWorkflowKey = input.workflowId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const resultUri = buildArtifactUri(
    input.artifactsBucket,
    `${safeWorkflowKey}/coding/${input.repository}/agent-result.json`,
  );
  const output: AgentOutput = {
    jobId: input.jobId,
    stage: 'coding',
    exitStatus: 'SUCCEEDED',
    message: result.message,
    outputArtifactUris: [resultUri],
    commitSha: result.commitSha,
    mrIid: result.mrIid,
    branch: result.branch,
  };
  await input.artifactStore.putObject(resultUri, JSON.stringify(output, null, 2));
  return output;
}

function isCodingInput(input: AgentInput | CodingInput): input is CodingInput {
  return (
    input.stage === 'coding' &&
    'repository' in input &&
    'workingBranch' in input &&
    'targetBranch' in input &&
    'approvedSpecHash' in input &&
    'expectedApprovedSpecHash' in input &&
    'gitlab' in input &&
    'artifactStore' in input &&
    'artifactsBucket' in input
  );
}
