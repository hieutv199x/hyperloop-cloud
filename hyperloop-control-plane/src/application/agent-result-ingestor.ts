import { validate } from '@hyperloop/contracts';
import type { ArtifactStore } from '../adapters/s3/artifact-store.js';
import type { PlanServiceNode, WorkflowRecord } from '../domain/types.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

export interface AgentResultManifest {
  jobId: string;
  stage: 'planner' | 'coding' | 'fix';
  exitStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  outputArtifactUris: string[];
  message?: string;
  errorCode?: string;
  specHash?: string;
  implementationSpecUri?: string;
  planServices?: PlanServiceNode[];
  commitSha?: string;
  mrIid?: number;
  branch?: string;
}

/**
 * Ingests agent Job result manifests from S3 into workflow state.
 * Control Plane only reads artifacts; agent execution stays in Job Pods.
 */
export class AgentResultIngestor {
  constructor(
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly artifacts: ArtifactStore,
  ) {}

  async loadManifest(resultUri: string): Promise<AgentResultManifest> {
    const raw = await this.artifacts.getObject(resultUri);
    const parsed = JSON.parse(raw) as unknown;
    const schema = validate('agent-result', parsed);
    if (!schema.valid) {
      throw new Error(`Invalid agent-result manifest at ${resultUri}`);
    }
    return parsed as AgentResultManifest;
  }

  async ingestPlanner(input: {
    workflowId: string;
    resultUri: string;
  }): Promise<WorkflowRecord> {
    const manifest = await this.loadManifest(input.resultUri);
    if (manifest.stage !== 'planner') {
      throw new Error(`Expected planner result, got ${manifest.stage}`);
    }
    if (manifest.exitStatus !== 'SUCCEEDED') {
      throw new Error(
        `Planner job failed: ${manifest.errorCode ?? manifest.message ?? manifest.exitStatus}`,
      );
    }
    if (!manifest.specHash || !manifest.implementationSpecUri) {
      throw new Error('Planner result missing specHash or implementationSpecUri');
    }
    return this.orchestrator.completePlanner(input.workflowId, {
      specHash: manifest.specHash,
      implementationSpecUri: manifest.implementationSpecUri,
      planServices: manifest.planServices,
    });
  }

  async ingestCoding(input: {
    workflowId: string;
    repository: string;
    jobId: string;
    resultUri: string;
  }): Promise<{ workflow: WorkflowRecord; newlyUnlocked: string[] }> {
    const manifest = await this.loadManifest(input.resultUri);
    if (manifest.stage !== 'coding') {
      throw new Error(`Expected coding result, got ${manifest.stage}`);
    }
    if (manifest.exitStatus !== 'SUCCEEDED') {
      throw new Error(
        `Coding job failed: ${manifest.errorCode ?? manifest.message ?? manifest.exitStatus}`,
      );
    }
    if (!manifest.commitSha || !manifest.mrIid) {
      throw new Error('Coding result missing commitSha or mrIid');
    }
    return this.orchestrator.recordCodingResult(input.workflowId, {
      repository: input.repository,
      commitSha: manifest.commitSha,
      mrIid: manifest.mrIid,
      jobId: input.jobId,
    });
  }
}

export function plannerResultUri(artifactsBucket: string, workflowId: string): string {
  const key = `${safeWorkflowKey(workflowId)}/plan/agent-result.json`;
  return `s3://${artifactsBucket}/${key}`;
}

export function codingResultUri(
  artifactsBucket: string,
  workflowId: string,
  repository: string,
): string {
  const key = `${safeWorkflowKey(workflowId)}/coding/${repository}/agent-result.json`;
  return `s3://${artifactsBucket}/${key}`;
}

function safeWorkflowKey(workflowId: string): string {
  return workflowId.replace(/[^a-zA-Z0-9._-]/g, '-');
}
