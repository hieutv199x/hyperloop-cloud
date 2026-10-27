import Fastify from 'fastify';
import { buildSpecApprovalCard } from '../cards/spec-approval.js';
import {
  handleApprovalCommand,
  HttpControlPlaneClient,
  type ControlPlaneApprovalClient,
} from '../commands/approve.js';
import { verifyTeamsIdentity } from '../security/identity.js';

export interface TeamsAppOptions {
  controlPlane?: ControlPlaneApprovalClient;
  controlPlaneBaseUrl?: string;
}

export function buildApp(options: TeamsAppOptions = {}) {
  const app = Fastify({ logger: true });
  const controlPlane =
    options.controlPlane ??
    new HttpControlPlaneClient(
      options.controlPlaneBaseUrl ?? process.env.CONTROL_PLANE_BASE_URL ?? 'http://localhost:8080',
    );

  app.get('/health', async () => ({ status: 'ok', service: 'hyperloop-teams-gateway' }));

  app.get('/cards/spec-approval/preview', async (request) => {
    const query = request.query as {
      workflowId?: string;
      specHash?: string;
      sddCommitSha?: string;
      expectedVersion?: string;
    };
    return buildSpecApprovalCard({
      workflowId: query.workflowId ?? 'WF#PAY-1234#1',
      specHash:
        query.specHash ??
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      sddCommitSha: query.sddCommitSha ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reviewUrl: 'https://example.invalid/specs/preview',
      expectedVersion: Number(query.expectedVersion ?? 3),
    });
  });

  app.post('/commands/approve', async (request, reply) => {
    try {
      const identity = verifyTeamsIdentity(request.headers);
      const body = request.body as {
        action?: string;
        workflowId?: string;
        expectedSpecHash?: string;
        expectedSddCommitSha?: string;
        expectedVersion?: number;
        comment?: string;
        approver?: { entraId?: string };
      };

      const result = await handleApprovalCommand(controlPlane, identity, body);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval command failed';
      const status = message.includes('Missing verified Entra') ? 401 : 400;
      return reply.code(status).send({ error: message });
    }
  });

  return app;
}
