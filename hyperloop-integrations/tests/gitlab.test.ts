import { describe, expect, it } from 'vitest';
import { InMemoryGitLabClient } from '../src/gitlab/client.js';

describe('GitLab M4', () => {
  it('forbids direct push to release branch', async () => {
    const gitlab = new InMemoryGitLabClient(new Set(['coc-ewallet-service']), [
      { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
    ]);
    await expect(
      gitlab.pushCommit({
        projectId: 'coc-ewallet-service',
        branch: 'release/2.5.0',
        message: 'nope',
        workflowMarker: 'hyperloop-workflow:WF#1',
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  it('creates MR idempotently by workflow marker', async () => {
    const gitlab = new InMemoryGitLabClient(new Set(['coc-ewallet-service']), [
      { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
    ]);
    const marker = 'hyperloop-workflow:WF#PAY-1234#1';
    await gitlab.pushCommit({
      projectId: 'coc-ewallet-service',
      branch: 'feature/PAY-1234',
      message: 'feat: PAY-1234',
      workflowMarker: marker,
    });

    const first = await gitlab.createOrUpdateMr({
      projectId: 'coc-ewallet-service',
      sourceBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      title: 'PAY-1234',
      description: marker,
      workflowMarker: marker,
    });
    const second = await gitlab.createOrUpdateMr({
      projectId: 'coc-ewallet-service',
      sourceBranch: 'feature/PAY-1234',
      targetBranch: 'release/2.5.0',
      title: 'PAY-1234',
      description: marker,
      workflowMarker: marker,
    });

    expect(first.iid).toBe(second.iid);
    expect(gitlab.mergeRequests).toHaveLength(1);
    expect(first.targetBranch).toBe('release/2.5.0');
  });

  it('reconciles MR after push when pod crashed before MR create', async () => {
    const gitlab = new InMemoryGitLabClient(new Set(['coc-ewallet-service']), [
      { projectId: 'coc-ewallet-service', name: 'release/2.5.0' },
    ]);
    const marker = 'hyperloop-workflow:WF#CRASH#1';
    await gitlab.pushCommit({
      projectId: 'coc-ewallet-service',
      branch: 'feature/x',
      message: 'feat',
      workflowMarker: marker,
    });

    const reconciled = await gitlab.reconcileAfterPush({
      projectId: 'coc-ewallet-service',
      sourceBranch: 'feature/x',
      targetBranch: 'release/2.5.0',
      title: 'recover',
      description: marker,
      workflowMarker: marker,
    });

    expect(reconciled.commit?.workflowMarker).toBe(marker);
    expect(reconciled.mr.iid).toBe(1);

    const again = await gitlab.reconcileAfterPush({
      projectId: 'coc-ewallet-service',
      sourceBranch: 'feature/x',
      targetBranch: 'release/2.5.0',
      title: 'recover',
      description: marker,
      workflowMarker: marker,
    });
    expect(again.mr.iid).toBe(1);
    expect(gitlab.mergeRequests).toHaveLength(1);
  });
});
