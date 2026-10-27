export interface JenkinsGateFailure {
  gate: string;
  classification: 'fixable' | 'non_fixable';
  message: string;
}

export interface JenkinsCiCallback {
  workflowId: string;
  repository: string;
  mrIid: number;
  commitSha: string;
  pipelineId: string;
  status: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE';
  buildId?: string;
  gateFailures?: JenkinsGateFailure[];
  reportUri?: string;
  logUri?: string;
}

const SHA_RE = /^[a-f0-9]{40}$/;

export class JenkinsCallbackParser {
  parse(body: unknown): JenkinsCiCallback {
    const payload = body as Partial<JenkinsCiCallback>;
    if (
      typeof payload.workflowId !== 'string' ||
      !payload.workflowId ||
      typeof payload.repository !== 'string' ||
      !payload.repository ||
      typeof payload.mrIid !== 'number' ||
      !Number.isInteger(payload.mrIid) ||
      payload.mrIid < 1 ||
      typeof payload.commitSha !== 'string' ||
      !SHA_RE.test(payload.commitSha) ||
      typeof payload.pipelineId !== 'string' ||
      !payload.pipelineId ||
      typeof payload.status !== 'string' ||
      !['SUCCESS', 'FAILURE', 'ABORTED', 'UNSTABLE'].includes(payload.status)
    ) {
      throw new Error('Invalid Jenkins CI callback payload');
    }
    return {
      workflowId: payload.workflowId,
      repository: payload.repository,
      mrIid: payload.mrIid,
      commitSha: payload.commitSha,
      pipelineId: payload.pipelineId,
      status: payload.status,
      buildId: payload.buildId,
      gateFailures: payload.gateFailures,
      reportUri: payload.reportUri,
      logUri: payload.logUri,
    };
  }

  isStale(expectedSha: string, callbackSha: string): boolean {
    return expectedSha !== callbackSha;
  }
}
