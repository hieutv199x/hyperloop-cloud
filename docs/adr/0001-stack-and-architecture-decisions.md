# ADR 0001: Stack and Architecture Decisions

**Status:** Accepted  
**Date:** 2026-10-27  
**Context:** Hyperloop Cloud engineering handoff (v1.1 baseline; planning model updated by ADR 0002 / handoff v1.2)

## Decisions

1. **Language / runtime:** TypeScript on Node.js 22 LTS for Control Plane, Contracts, Integrations, Agent Runtime, and Teams Gateway.
2. **HTTP framework:** Fastify (Control Plane, Teams Gateway).
3. **Validation:** JSON Schema (Draft 2020-12) as source of truth in `hyperloop-contracts`; Ajv (+ formats) for runtime validation; Zod only for local config/env parsing where useful.
4. **AWS:** AWS SDK for JavaScript v3; DynamoDB single-table design with conditional / transactional writes; S3 for artifacts; SQS for wake-up hints only.
5. **Kubernetes:** `@kubernetes/client-node` for Job create/watch; ephemeral Jobs only (`backoffLimit: 0`, TTL after finish).
6. **AI runtime:** Kiro CLI headless inside agent Jobs. No separate LLM gateway.
7. **Test stack:** Vitest for unit/integration; DynamoDB Local / LocalStack / mocks for AWS; fake Kubernetes adapter until M2.
8. **Repo layout:** Six independent repositories under `/Users/macbook/Work/HyperLoop` (not a monorepo). Shared contracts published from `hyperloop-contracts` and consumed as a pinned dependency / vendored schemas.
9. **Concurrency:** Global admission cap of 100 Agent Job reservations enforced in DynamoDB before Kubernetes create (M1.5 before M2).

## Repository dependency graph

```text
hyperloop-contracts
        │
        ├──────────────────┬──────────────────┐
        ▼                  ▼                  ▼
hyperloop-control-plane   hyperloop-integrations   hyperloop-agent-runtime
        │                          │                      │
        ├──────────────────────────┘                      │
        ▼                                                 │
hyperloop-teams-gateway                                   │
        ▲                                                 │
        └──────────── hyperloop-infrastructure ───────────┘
                      (Terraform / Helm / K8s for all)
```

## Out of scope for v1

- Replacing Jenkins, GitLab, or Nexus
- Always-on Kiro worker pools / KEDA ScaledJobs per DAG stage
- Multi-region active-active orchestration
- Autonomous merge to release branches
