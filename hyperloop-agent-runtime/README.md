# hyperloop-agent-runtime

Ephemeral Kubernetes Job runtime for Planner, Coding, and Fix roles using **Kiro CLI headless**.

## Setup

```bash
npm install --prefix ../hyperloop-contracts && npm run build --prefix ../hyperloop-contracts
npm install
npm test
npm run build
```

## Images (v1.3)

Role images are built from the **monorepo root**:

```bash
KIRO_CLI_VERSION=unpinned ./scripts/build-images.sh
```

| Image | Dockerfile |
|---|---|
| `kiro-agent-base` | `docker/Dockerfile.base` |
| `kiro-agent-planner` | `docker/Dockerfile.planner` |
| `kiro-agent-coding` | `docker/Dockerfile.coding` |
| `kiro-agent-fix` | `docker/Dockerfile.fix` |

`KIRO_CLI_VERSION` is required. Use `unpinned` until the [Kiro headless spike](../docs/spikes/kiro-cli-headless.md) completes — do not invent install flags.

## Roles

| Stage | Milestone | Responsibility |
|---|---|---|
| planner | M2 | Implementation Spec + DAG + specHash artifacts; no code push |
| coding | M4 | Checkout working branch, Kiro stub, commit/push, idempotent MR to release |
| fix | M6 | Bounded fix on same MR branch (max 2 auto attempts) |

Agents must not acquire/release global admission slots (M1.5: Control Plane owns capacity; agent pods never mutate SQS/DynamoDB quota).
