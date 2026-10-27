import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../src/artifacts/memory-store.js';
import { runAgent } from '../src/runner/run-agent.js';
import { scrubSecrets } from '../src/security/scrub.js';

describe('agent-runtime scaffold', () => {
  it('runs planner with full M2 input', async () => {
    const result = await runAgent({
      stage: 'planner',
      jobId: 'job-1',
      workflowId: 'WF#1',
      sddCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifactsBucket: 'hyperloop-artifacts',
      artifactStore: new InMemoryArtifactStore(),
      devSpec: {
        metadata: { project: 'p', userStory: 'US-1', revision: 1 },
        spec: {
          requirements: ['r.md'],
          designs: ['d.md'],
          targets: [
            {
              repository: 'svc',
              workingBranch: 'feature/x',
              targetBranch: 'release/1.0.0',
            },
          ],
        },
      },
    });
    expect(result.exitStatus).toBe('SUCCEEDED');
    expect(result.stage).toBe('planner');
    expect(result.specHash).toMatch(/^sha256:/);
  });

  it('scrubs secrets from logs', () => {
    expect(scrubSecrets('token=glpat-abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED]');
  });
});
