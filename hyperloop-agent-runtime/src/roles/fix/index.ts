import type { ArtifactStore } from '../../artifacts/types.js';
import { buildArtifactUri } from '../../artifacts/types.js';
import type { AgentInput, AgentOutput } from '../../runner/run-agent.js';
import { invokeKiroFix } from '../../runner/kiro-fix.js';
import type { AuthorizePushClient } from '../../security/authorize-push.js';
import {
  workflowMarker,
  type CodingGitLabPort,
} from '../coding/index.js';

export interface FixInput extends AgentInput {
  stage: 'fix';
  repository: string;
  workingBranch: string;
  targetBranch: string;
  approvedSpecHash: string;
  expectedApprovedSpecHash: string;
  failedCommitSha: string;
  ciReportUri: string;
  fixAttempt: 1 | 2;
  artifactsBucket: string;
  artifactStore: ArtifactStore;
  gitlab: CodingGitLabPort;
  executionId?: string;
  fenceToken?: string;
  authorizePush?: AuthorizePushClient;
  assertPushAllowed?: () => void;
  /** Optional HEAD resolver when checkout does not return sha. */
  resolveHeadSha?: () => Promise<string>;
}

function isFixInput(input: AgentInput): input is FixInput {
  const candidate = input as Partial<FixInput>;
  return (
    input.stage === 'fix' &&
    typeof candidate.repository === 'string' &&
    typeof candidate.workingBranch === 'string' &&
    typeof candidate.targetBranch === 'string' &&
    typeof candidate.approvedSpecHash === 'string' &&
    typeof candidate.expectedApprovedSpecHash === 'string' &&
    typeof candidate.failedCommitSha === 'string' &&
    typeof candidate.ciReportUri === 'string' &&
    (candidate.fixAttempt === 1 || candidate.fixAttempt === 2) &&
    typeof candidate.artifactsBucket === 'string' &&
    !!candidate.artifactStore &&
    !!candidate.gitlab
  );
}

/**
 * Fix Agent: same MR source branch, reject HEAD drift, push fix commit, never open a second MR.
 */
export async function runFix(input: AgentInput | FixInput): Promise<AgentOutput> {
  if (!isFixInput(input)) {
    return {
      jobId: input.jobId,
      stage: 'fix',
      exitStatus: 'FAILED',
      message:
        'Fix requires repository, branches, failedCommitSha, ciReportUri, fixAttempt∈{1,2}, gitlab, artifactStore',
      outputArtifactUris: [],
      errorCode: 'HL_FIX_INVALID_INPUT',
    };
  }

  if (input.approvedSpecHash !== input.expectedApprovedSpecHash) {
    return {
      jobId: input.jobId,
      stage: 'fix',
      exitStatus: 'FAILED',
      message: 'approvedSpecHash does not match expected approved hash',
      outputArtifactUris: [],
      errorCode: 'HL_FIX_SPEC_HASH_MISMATCH',
    };
  }

  if (input.fixAttempt < 1 || input.fixAttempt > 2) {
    return {
      jobId: input.jobId,
      stage: 'fix',
      exitStatus: 'FAILED',
      message: `fixAttempt out of range: ${input.fixAttempt}`,
      outputArtifactUris: [],
      errorCode: 'HL_FIX_ATTEMPT_EXHAUSTED',
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
      (checkedOut as { commitSha?: string })?.commitSha ??
      (await input.resolveHeadSha?.());

    if (!headSha) {
      return {
        jobId: input.jobId,
        stage: 'fix',
        exitStatus: 'FAILED',
        message: 'Unable to resolve working branch HEAD SHA',
        outputArtifactUris: [],
        errorCode: 'HL_FIX_HEAD_UNKNOWN',
        branch: input.workingBranch,
      };
    }

    if (headSha !== input.failedCommitSha) {
      return {
        jobId: input.jobId,
        stage: 'fix',
        exitStatus: 'FAILED',
        message: `Stale HEAD ${headSha} ≠ failedCommitSha ${input.failedCommitSha}; refusing push`,
        outputArtifactUris: [],
        errorCode: 'HL_FIX_STALE_HEAD',
        branch: input.workingBranch,
      };
    }

    // Existing MR must already exist — Fix never creates a second MR.
    const existingMr = await input.gitlab.findMrByWorkflowMarker(input.repository, marker);
    if (!existingMr) {
      return {
        jobId: input.jobId,
        stage: 'fix',
        exitStatus: 'FAILED',
        message: 'No existing MR for workflow marker; Fix will not create a new MR',
        outputArtifactUris: [],
        errorCode: 'HL_FIX_MR_MISSING',
        branch: input.workingBranch,
      };
    }

    let ciReport = '';
    try {
      ciReport = await input.artifactStore.getObject(input.ciReportUri);
    } catch {
      ciReport = `unavailable:${input.ciReportUri}`;
    }

    const generated = await invokeKiroFix({
      workflowId: input.workflowId,
      repository: input.repository,
      failedCommitSha: input.failedCommitSha,
      fixAttempt: input.fixAttempt,
      ciReportExcerpt: ciReport,
    });

    const fenced = await enforceFence(input);
    if (fenced) return fenced;

    const commit = await input.gitlab.pushCommit({
      projectId: input.repository,
      branch: input.workingBranch,
      message: `fix(${input.fixAttempt}): ${generated.summary}`,
      workflowMarker: marker,
      files: generated.files,
    });

    // Re-check MR count — still exactly one.
    const mrAfter = await input.gitlab.findMrByWorkflowMarker(input.repository, marker);
    if (!mrAfter || mrAfter.iid !== existingMr.iid) {
      return {
        jobId: input.jobId,
        stage: 'fix',
        exitStatus: 'FAILED',
        message: 'MR identity changed during fix; aborting',
        outputArtifactUris: [],
        errorCode: 'HL_FIX_MR_DRIFT',
        branch: input.workingBranch,
      };
    }

    return persistFixResult(input, {
      commitSha: commit.sha,
      mrIid: existingMr.iid,
      branch: input.workingBranch,
      message: generated.summary,
    });
  } catch (error) {
    return {
      jobId: input.jobId,
      stage: 'fix',
      exitStatus: 'FAILED',
      message: error instanceof Error ? error.message : 'Fix failed',
      outputArtifactUris: [],
      errorCode: 'HL_FIX_FAILED',
      branch: (input as FixInput).workingBranch,
    };
  }
}

async function enforceFence(input: FixInput): Promise<AgentOutput | null> {
  if (input.authorizePush && input.executionId && input.fenceToken) {
    const decision = await input.authorizePush({
      executionId: input.executionId,
      fenceToken: input.fenceToken,
    });
    if (decision === 'denied') {
      return {
        jobId: input.jobId,
        stage: 'fix',
        exitStatus: 'FAILED',
        message: `Execution fenced for ${input.executionId}; further push denied`,
        outputArtifactUris: [],
        errorCode: 'HL_FIX_EXECUTION_FENCED',
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
      stage: 'fix',
      exitStatus: 'FAILED',
      message: error instanceof Error ? error.message : 'Push fenced',
      outputArtifactUris: [],
      errorCode: 'HL_FIX_EXECUTION_FENCED',
      branch: input.workingBranch,
    };
  }
}

async function persistFixResult(
  input: FixInput,
  result: { commitSha: string; mrIid: number; branch: string; message: string },
): Promise<AgentOutput> {
  const safeWorkflowKey = input.workflowId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const resultUri = buildArtifactUri(
    input.artifactsBucket,
    `${safeWorkflowKey}/fix/${input.repository}/attempt-${input.fixAttempt}/agent-result.json`,
  );
  const output: AgentOutput = {
    jobId: input.jobId,
    stage: 'fix',
    exitStatus: 'SUCCEEDED',
    message: result.message,
    outputArtifactUris: [resultUri],
    commitSha: result.commitSha,
    mrIid: result.mrIid,
    branch: result.branch,
  };
  await input.artifactStore.putObject(
    resultUri,
    JSON.stringify(output, null, 2),
    'application/json',
  );
  return output;
}
