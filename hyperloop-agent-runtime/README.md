# hyperloop-agent-runtime

Ephemeral Kubernetes Job runtime for Planner, Coding, and Fix roles using **Kiro CLI headless**.

## Setup

```bash
npm install --prefix ../hyperloop-contracts && npm run build --prefix ../hyperloop-contracts
npm install
npm test
npm run build
```

## Roles

| Stage | Milestone | Responsibility |
|---|---|---|
| planner | M2 | Implementation Spec + DAG + specHash artifacts; no code push |
| coding | M4 | Checkout working branch, Kiro stub, commit/push, idempotent MR to release |
| fix | M6 | Bounded fix on same MR branch (max 2 auto attempts) |

Agents must not acquire/release global admission slots (M1.5: Control Plane owns capacity; agent pods never mutate SQS/DynamoDB quota).
