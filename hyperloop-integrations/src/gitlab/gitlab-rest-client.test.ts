import { describe, expect, it, vi } from 'vitest';
import { GitLabRestClient } from './gitlab-rest-client.js';
import { GitLabRestSddReader } from './gitlab-rest-sdd-reader.js';

describe('GitLabRestClient (recorded fixtures)', () => {
  it('finds MR by workflow marker and updates instead of creating a second MR', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/merge_requests?')) {
        return new Response(
          JSON.stringify([
            {
              iid: 7,
              web_url: 'https://gitlab.example/g/-/merge_requests/7',
              source_branch: 'hyperloop/wf-1',
              target_branch: 'release/1.0.0',
              description: 'plan\n\nHL_MARKER_ABC',
            },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ iid: 7 }), { status: 200 });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });

    const client = new GitLabRestClient({
      baseUrl: 'https://gitlab.example',
      token: 'glpat-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const mr = await client.createOrUpdateMr({
      projectId: 'group/app',
      sourceBranch: 'hyperloop/wf-1',
      targetBranch: 'release/1.0.0',
      title: 'Hyperloop coding',
      description: 'updated',
      workflowMarker: 'HL_MARKER_ABC',
    });
    expect(mr.iid).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit?];
    expect(String(secondCall[0])).toContain('/merge_requests/7');
  });

  it('refuses push to release/*', () => {
    const client = new GitLabRestClient({
      baseUrl: 'https://gitlab.example',
      token: 'x',
    });
    expect(() => client.assertNotReleaseBranchPush('release/1.2.3')).toThrow(/release/);
  });
});

describe('GitLabRestSddReader', () => {
  it('fetches file at exact ref SHA (base64 fixture)', async () => {
    const sha = 'a'.repeat(40);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: Buffer.from('# DEV-SPEC\n', 'utf8').toString('base64'),
          encoding: 'base64',
        }),
        { status: 200 },
      ),
    );
    const reader = new GitLabRestSddReader({
      baseUrl: 'https://gitlab.example',
      token: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snap = await reader.fetchPinnedPackage({
      sddProject: 'group/app-sdd',
      sddCommitSha: sha,
      paths: ['specs/dev-spec.md'],
    });
    expect(snap.files['specs/dev-spec.md']).toContain('DEV-SPEC');
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit?];
    expect(String(firstCall[0])).toContain(`ref=${sha}`);
  });
});
