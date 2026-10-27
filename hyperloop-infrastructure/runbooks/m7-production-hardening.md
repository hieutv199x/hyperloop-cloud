# M7 — Production hardening runbook

## Processes

| Process | Command | Responsibility |
|---|---|---|
| Control Plane API | `node dist/index.js api` | HTTP + EventConsumer poll (SDD/CI/MR) |
| Control Plane Scheduler | `node dist/index.js scheduler` | dispatchOnce + reconcileReserved + finalizeTerminalJobs |
| Event Gateway | `node dist/event-gateway/main.js` | Webhooks → SQS |
| Teams Gateway | teams-gateway image | HITL cards |

## Crash recovery expectations

1. **Scheduler crash after RESERVE:** `reconcileReserved` looks up deterministic Job name; `createJob` treats 409 as idempotent.
2. **Agent crash after git push:** Coding retry uses `reconcileAfterPush` / workflow marker — no second commit/MR.
3. **Duplicate Jenkins callback:** `seenPipelineIds` → no-op (zero extra Fix Jobs).
4. **Cancel:** QUEUED cancel does not touch capacity; SCHEDULED/RUNNING delete Job then release-once.
5. **Timeout:** Job `activeDeadlineSeconds` → Failed → `finalizeTerminalJobs` release-once.

## Observability

- `GET /health` — liveness
- `GET /metrics` — scheduler metrics, capacity snapshot, queue depths
- `GET /scheduler/capacity` — admission used/limit
- CloudWatch: wire DynamoDB throttle, SQS DLQ depth, Job Failed count (env-specific)

## Secrets

- No secrets in Helm values or images.
- IRSA annotations on ServiceAccounts (see Helm `serviceAccount.annotations`).
- Webhook secrets only via Kubernetes Secret → env on Event Gateway.

## Karpenter

Agent NodePool taint `hyperloop.dev/workload=agents:NoSchedule` — Job templates must tolerate it (`helm/agent-job` job-defaults).

## Remaining external blockers

- Kiro CLI version/flags (`docs/spikes/kiro-cli-headless.md`)
- Nexus push credentials
- Live GitLab/Jenkins token scopes
