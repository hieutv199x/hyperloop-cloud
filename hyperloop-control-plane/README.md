# hyperloop-control-plane

Workflow orchestration, webhooks, DynamoDB persistence, and (M1.5) queue/scheduler/admission.

## Setup

```bash
# build contracts first (file: dependency)
npm install --prefix ../hyperloop-contracts
npm run build --prefix ../hyperloop-contracts

npm install
npm test
npm run build
npm run dev
```

## Endpoints

- `GET /health`
- `POST /webhooks/gitlab/sdd` — idempotent DEV-Spec intake (M1)
- `GET /workflows/:id`, `GET /workflows/:id/timeline`
- `POST /workflows/:id/complete-planner` — M1 helper until Job watcher (M2)
- `POST /workflows/:id/cancel`, `POST /workflows/:id/resume`
- `POST /workflows/:id/approve-spec` → 501 until M3
- `GET /scheduler/capacity` — scaffold until M1.5

## M1 acceptance

- [x] Submit DEV-Spec → workflow `PLANNING` + planner `JOB_DESIRED` persisted before K8s create
- [x] Duplicate `eventId` does not create a second workflow
- [x] Fake Kubernetes adapter used in tests
- [x] In-memory repository + DynamoDB conditional-write adapter
- [x] Helper transition to `WAITING_SPEC_APPROVAL` after planner completion

## M1.5 acceptance

- [x] Global 100-slot atomic admission (`RESERVED`/`SCHEDULED`/`Pending`/`Running` count)
- [x] Durable `QUEUED` ready-work + SQS wake-up hints (ack after durable enqueue)
- [x] Multi-replica safe reserve via store lock / conditional semantics
- [x] Soft fairness + aging; reconciler after reserve-before-create crash
- [x] Admin: `GET /scheduler/capacity`, `GET /scheduler/queues`, `GET /workflows/:id/tasks`
- [x] Fault-injection suite in `src/scheduler/m1_5.acceptance.test.ts`

## Remaining risks before M2

- In-memory atomic store stands in for DynamoDB `TransactWriteItems`; wire `DynamoDbWorkflowRepository`-style transactional capacity next when AWS account/emulator is available.
- Real SQS SDK consumer/publisher not yet connected (InMemoryQueueBus validates semantics).
- Soft fairness `perProjectLimit` is configurable but not fully counted against already-active project reservations.
- No leader lease yet (optional); replicas rely entirely on conditional reserve conflicts.

## M2 / v1.2 SDD-only acceptance

- [x] `sdd-manifest` schema + completeness / dependency / consolidation services
- [x] Missing SDD docs → `NEEDS_SPEC_CLARIFICATION` path (no Planner schedule)
- [x] Planner scope cannot silently widen beyond SDD declarations
- [x] Revision manager: duplicate ignore, supersede, unrelated no-replan, execution fence
- [x] HITL binds `specHash` **and** pinned `sddCommitSha`
- [x] Planner/coding results ingested from S3 manifests (`AgentResultIngestor`); CP does not run agents in-process (v1.3)
- [x] Role images via `AGENT_IMAGE_PLANNER|CODING|FIX` + allowlist
- [x] Integrations `GitLabSDDReader` + `DevSpecChangeDetector` (in-memory; live API later)
- [x] Agent `SDDPackageLoader` / SDD-only planner context; coding push fencing hook
- [ ] Real Kiro CLI headless flags pinned in Nexus image spike

## M3 acceptance

- [x] `POST /workflows/:id/approve-spec` binds decision to exact `specHash` + `expectedVersion`
- [x] Server-side Entra allowlist; Teams header identity preferred over card body
- [x] APPROVED unlocks coding DAG roots only; no coding before approval
- [x] Spec hash change invalidates prior approvals
- [x] Concurrent approvers: conditional write — one wins

## M4 acceptance

- [x] Coding Job checks out working branch; MR targets DEV-Spec release branch
- [x] Never push directly to `release/x.y.z`
- [x] Idempotent MR + crash-after-push recovery via workflow marker
- [x] Record `AWAITING_CI` + unlock dependent DAG coding tasks
- [x] Ephemeral Job slot released after coding completes

## Milestone focus

- M5: Jenkins CI callback + stale SHA filtering
- M6: bounded Fix loop


