# Hyperloop Cloud

Engineering workspace for the Hyperloop Cloud platform (AWS EKS + DynamoDB + S3 + GitLab + Jenkins + Nexus + Teams). Production AI agents use **Kiro CLI headless** in ephemeral Kubernetes Jobs.

## Repositories

| Repository | Priority | Role |
|---|---|---|
| [hyperloop-contracts](./hyperloop-contracts) | P0 | JSON Schema, OpenAPI, AsyncAPI, validators |
| [hyperloop-control-plane](./hyperloop-control-plane) | P0 | Workflow orchestration, scheduler, admission |
| [hyperloop-agent-runtime](./hyperloop-agent-runtime) | P0 | Planner / Coding / Fix agent Jobs |
| [hyperloop-integrations](./hyperloop-integrations) | P0 | GitLab + Jenkins adapters |
| [hyperloop-infrastructure](./hyperloop-infrastructure) | P0 | Terraform, Helm, K8s manifests |
| [hyperloop-teams-gateway](./hyperloop-teams-gateway) | P1 | Teams approval / escalation cards |

## Source of truth

See [HYPERLOOP_CODEX_HANDOFF.md](./HYPERLOOP_CODEX_HANDOFF.md) (**v1.2** — SDD-only planning, Section 15 authoritative), [docs/adr/0001-stack-and-architecture-decisions.md](./docs/adr/0001-stack-and-architecture-decisions.md), and [docs/adr/0002-sdd-only-planning-v1.2.md](./docs/adr/0002-sdd-only-planning-v1.2.md).

## Milestone order

`M0 Contracts` → `M1 Control Plane` → `M1.5 Queue & 100-slot concurrency` → `M2 SDD-only Planner` → `M3 HITL` → `M4 Coding/MR` → `M5 Jenkins` → `M6 Fix loop` → `M7 Hardening`
