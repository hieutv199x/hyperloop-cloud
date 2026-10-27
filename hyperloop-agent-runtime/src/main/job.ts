import { readFile } from 'node:fs/promises';
import { runAgent } from '../runner/run-agent.js';

/**
 * Kubernetes Job entrypoint. Contract is mounted at HYPERLOOP_CONTRACT_PATH
 * (default /hyperloop/contract.json) and/or referenced by HYPERLOOP_CONTRACT_URI.
 */
async function main(): Promise<void> {
  const imageRole = process.env.HYPERLOOP_IMAGE_ROLE;
  const runtimeRole = process.env.HYPERLOOP_ROLE ?? process.env.HYPERLOOP_STAGE;
  if (imageRole && runtimeRole && imageRole !== runtimeRole) {
    console.error(
      `[hyperloop-agent] role mismatch: image=${imageRole} runtime=${runtimeRole}`,
    );
    process.exit(64);
  }

  const contractPath = process.env.HYPERLOOP_CONTRACT_PATH ?? '/hyperloop/contract.json';
  let contract: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(contractPath, 'utf8');
    contract = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    contract = undefined;
  }

  if (contract?.role && imageRole && contract.role !== imageRole) {
    console.error(
      `[hyperloop-agent] contract role ${String(contract.role)} != image role ${imageRole}`,
    );
    process.exit(64);
  }

  const stage = String(
    runtimeRole ?? contract?.role ?? process.env.HYPERLOOP_STAGE ?? 'planner',
  );
  const jobId = String(process.env.HYPERLOOP_JOB_ID ?? contract?.jobId ?? 'unknown');
  const workflowId = String(
    process.env.HYPERLOOP_WORKFLOW_ID ?? contract?.workflowId ?? 'unknown',
  );

  console.log(
    `[hyperloop-agent] job ready role=${stage} job=${jobId} workflow=${workflowId}`,
  );

  // Full contract-driven execution (Kiro + GitLab) lands with P10 / production adapters.
  // Until then, Jobs validate role/contract and exit successfully for image smoke tests.
  if (process.env.HYPERLOOP_JOB_EXECUTE !== 'true') {
    console.log(
      '[hyperloop-agent] HYPERLOOP_JOB_EXECUTE!=true — smoke exit (set true when contract runner is wired)',
    );
    return;
  }

  const result = await runAgent({
    stage,
    jobId,
    workflowId,
  });
  console.log(JSON.stringify(result));
  if (result.exitStatus !== 'SUCCEEDED') {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
