import { describe, expect, it } from 'vitest';
import { InMemoryWorkflowRepository } from '../adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../adapters/kubernetes/fake-kubernetes.js';
import { InMemoryArtifactStore } from '../adapters/s3/artifact-store.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import { AgentResultIngestor } from './agent-result-ingestor.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('AgentResultIngestor', () => {
  it('ingests planner manifest into WAITING_SPEC_APPROVAL', async () => {
    const repository = new InMemoryWorkflowRepository();
    const kubernetes = new FakeKubernetesAdapter();
    const artifacts = new InMemoryArtifactStore();
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes,
      agentNamespace: 'hyperloop-agents',
      agentImages: {
        planner: 'nexus.example/hyperloop/kiro-agent-planner:0.1.0',
        coding: 'nexus.example/hyperloop/kiro-agent-coding:0.1.0',
        fix: 'nexus.example/hyperloop/kiro-agent-fix:0.1.0',
      },
    });

    await orchestrator.submitDevSpec({
      eventId: 'evt-ingest-1',
      occurredAt: new Date().toISOString(),
      project: 'transaction-banking',
      userStory: 'PAY-9001',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: 'dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'transaction-banking',
          userStory: 'PAY-9001',
          revision: 1,
        },
        spec: {
          status: 'submitted',
          requirements: ['r.md'],
          designs: ['d.md'],
          acceptanceCriteria: ['ac.md'],
          targets: [
            {
              repository: 'coc-ewallet-service',
              workingBranch: 'feature/PAY-9001',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    const resultUri = 's3://hyperloop-artifacts/WF-PAY-9001-1/plan/agent-result.json';
    await artifacts.putObject(
      resultUri,
      JSON.stringify({
        jobId: 'WF#PAY-9001#1:planner:1',
        stage: 'planner',
        exitStatus: 'SUCCEEDED',
        outputArtifactUris: ['s3://hyperloop-artifacts/WF-PAY-9001-1/plan/implementation-spec.json'],
        message: 'ok',
        specHash: SPEC,
        implementationSpecUri:
          's3://hyperloop-artifacts/WF-PAY-9001-1/plan/implementation-spec.json',
        planServices: [
          {
            repository: 'coc-ewallet-service',
            workingBranch: 'feature/PAY-9001',
            targetBranch: 'release/2.5.0',
            dependsOn: [],
          },
        ],
      }),
    );

    const ingestor = new AgentResultIngestor(orchestrator, artifacts);
    const workflow = await ingestor.ingestPlanner({
      workflowId: 'WF#PAY-9001#1',
      resultUri,
    });

    expect(workflow.status).toBe('WAITING_SPEC_APPROVAL');
    expect(workflow.specHash).toBe(SPEC);
  });
});
