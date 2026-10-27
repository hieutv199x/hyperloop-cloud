import { describe, expect, it } from 'vitest';
import { InMemoryGitLabClient } from '@hyperloop/integrations';
import { InMemoryWorkflowRepository } from '../../hyperloop-control-plane/src/adapters/dynamodb/in-memory-workflow-repository.js';
import { FakeKubernetesAdapter } from '../../hyperloop-control-plane/src/adapters/kubernetes/fake-kubernetes.js';
import { InMemoryArtifactStore } from '../../hyperloop-control-plane/src/adapters/s3/artifact-store.js';
import { AgentResultIngestor } from '../../hyperloop-control-plane/src/application/agent-result-ingestor.js';
import { ApprovalService } from '../../hyperloop-control-plane/src/application/approval-service.js';
import { WorkflowOrchestrator } from '../../hyperloop-control-plane/src/application/workflow-orchestrator.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../../hyperloop-control-plane/src/scheduler/config.js';
import { JobQueueScheduler } from '../../hyperloop-control-plane/src/scheduler/job-queue-scheduler.js';
import { ApproverPolicy } from '../../hyperloop-control-plane/src/security/approver-policy.js';
import { simulateCodingJob } from '../src/agent-job-simulator.js';

const SPEC =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('e2e M4 coding (agent outside Control Plane)', () => {
  it('approved plan → coding Job → ingest → AWAITING_CI; unlocks dependent', async () => {
    const repository = new InMemoryWorkflowRepository();
    const kubernetes = new FakeKubernetesAdapter();
    const artifacts = new InMemoryArtifactStore();
    const scheduler = new JobQueueScheduler(DEFAULT_SCHEDULER_CONFIG, kubernetes);
    const orchestrator = new WorkflowOrchestrator({
      repository,
      kubernetes,
      agentNamespace: 'hyperloop-agents',
      agentImages: DEFAULT_SCHEDULER_CONFIG.kubernetes.images,
      approverPolicy: ApproverPolicy.allowAllForDev(),
      onApprovalsInvalidated: (id) => scheduler.store.clearSpecApproval(id),
    });
    const approvals = new ApprovalService(orchestrator, scheduler);
    const ingestor = new AgentResultIngestor(orchestrator, artifacts);
    const gitlab = new InMemoryGitLabClient(
      new Set(['coc-ewallet-service', 'access-control-adapter']),
      [
        { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
        { projectId: 'access-control-adapter', name: 'release/2.5.0' },
      ],
    );

    await orchestrator.submitDevSpec({
      eventId: 'evt-m4',
      occurredAt: new Date().toISOString(),
      project: 'transaction-banking',
      userStory: 'PAY-4000',
      revision: 1,
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sddPath: 'dev-spec.yaml',
      devSpec: {
        apiVersion: 'hyperloop.dev/v1',
        kind: 'DevelopmentSpec',
        metadata: {
          project: 'transaction-banking',
          userStory: 'PAY-4000',
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
              workingBranch: 'feature/PAY-4000',
              targetBranch: 'release/2.5.0',
            },
            {
              repository: 'access-control-adapter',
              workingBranch: 'feature/PAY-4000',
              targetBranch: 'release/2.5.0',
            },
          ],
          execution: { requireSpecApproval: true, maxAutoFixAttempts: 2 },
        },
      },
    });

    await orchestrator.completePlanner('WF#PAY-4000#1', {
      specHash: SPEC,
      implementationSpecUri: 's3://hyperloop-artifacts/plan.json',
      planServices: [
        {
          repository: 'coc-ewallet-service',
          workingBranch: 'feature/PAY-4000',
          targetBranch: 'release/2.5.0',
          dependsOn: [],
        },
        {
          repository: 'access-control-adapter',
          workingBranch: 'feature/PAY-4000',
          targetBranch: 'release/2.5.0',
          dependsOn: ['coc-ewallet-service'],
        },
      ],
    });

    const waiting = await orchestrator.getWorkflow('WF#PAY-4000#1');
    const approved = await approvals.approve({
      workflowId: 'WF#PAY-4000#1',
      approvedSpecHash: SPEC,
      approvedSddCommitSha: waiting!.sddCommitSha,
      decision: 'APPROVED',
      expectedVersion: waiting!.version,
      approver: { entraId: 'entra-alice', displayName: 'Alice' },
    });

    const codingTaskId = approved.codingTasksEnqueued[0]!;
    expect(codingTaskId).toBe('WF#PAY-4000#1:coding:coc-ewallet-service:1');

    await scheduler.dispatchOnce();
    await scheduler.reconciler.reconcileReserved();

    let task = scheduler.store.getTask(codingTaskId);
    if (!task?.k8sJobName) {
      const reservation = await scheduler.reservations.reserveWithBackoff(codingTaskId);
      expect(reservation).toBeTruthy();
      task = scheduler.store.getTask(codingTaskId)!;
      await scheduler.dispatcher.dispatch(task, reservation!);
      await scheduler.store.markScheduled(codingTaskId);
      task = scheduler.store.getTask(codingTaskId)!;
    }

    const service = (await orchestrator.getWorkflow('WF#PAY-4000#1'))!.services[
      'coc-ewallet-service'
    ]!;

    const resultUri = await simulateCodingJob({
      jobId: codingTaskId,
      workflowId: 'WF#PAY-4000#1',
      repository: service.repository,
      workingBranch: service.workingBranch,
      targetBranch: service.targetBranch,
      approvedSpecHash: SPEC,
      artifactsBucket: 'hyperloop-artifacts',
      artifacts,
      kubernetes,
      namespace: 'hyperloop-agents',
      k8sJobName: task.k8sJobName!,
      gitlab,
    });

    await scheduler.finalizeFromKubernetes(codingTaskId);
    const coded = await ingestor.ingestCoding({
      workflowId: 'WF#PAY-4000#1',
      repository: 'coc-ewallet-service',
      jobId: codingTaskId,
      resultUri,
    });

    for (const repo of coded.newlyUnlocked) {
      await scheduler.enqueue({
        taskId: `WF#PAY-4000#1:coding:${repo}:1`,
        workflowId: 'WF#PAY-4000#1',
        stage: 'coding',
        repository: repo,
        project: 'transaction-banking',
        approvedSpecHash: SPEC,
        attempt: 1,
      });
    }

    expect(coded.workflow.services['coc-ewallet-service']?.state).toBe('AWAITING_CI');
    expect(coded.workflow.services['coc-ewallet-service']?.mrIid).toBe(1);
    expect(coded.newlyUnlocked).toEqual(['access-control-adapter']);
    expect(gitlab.mergeRequests[0]?.targetBranch).toBe('release/2.5.0');
    expect(scheduler.store.getTask('WF#PAY-4000#1:coding:access-control-adapter:1')?.status).toBe(
      'QUEUED',
    );
    expect(scheduler.store.capacity.getState().used).toBe(0);
  });
});
