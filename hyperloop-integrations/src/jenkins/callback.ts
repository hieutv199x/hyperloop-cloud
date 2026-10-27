export interface JenkinsCiCallback {
  workflowId: string;
  repository: string;
  mrIid: number;
  commitSha: string;
  pipelineId: string;
  status: 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE';
}

export class JenkinsCallbackParser {
  parse(body: unknown): JenkinsCiCallback {
    const payload = body as Partial<JenkinsCiCallback>;
    if (
      !payload.workflowId ||
      !payload.repository ||
      !payload.mrIid ||
      !payload.commitSha ||
      !payload.pipelineId ||
      !payload.status
    ) {
      throw new Error('Invalid Jenkins CI callback payload');
    }
    return payload as JenkinsCiCallback;
  }

  isStale(expectedSha: string, callbackSha: string): boolean {
    return expectedSha !== callbackSha;
  }
}
