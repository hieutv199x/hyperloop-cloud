# ADR 0003: Deployable service boundaries (handoff v1.3)

**Status:** Accepted  
**Date:** 2026-10-27  
**Context:** Section 0 of `HYPERLOOP_CODEX_HANDOFF.md` (v1.3) makes deployable boundaries explicit. Authoritative over ambiguous older sections; v1.2 SDD-only planning and M1.5 admission remain in force.

## Decision

1. **Four always-on EKS Deployments** in `hyperloop-system`: Event Gateway, Control Plane API, Control Plane Scheduler, Teams Gateway.
2. **Three ephemeral Job roles** in `hyperloop-agents`: Planner, Coding, Fix — never Deployments.
3. **Six application images** (private Nexus): `event-gateway`, `control-plane` (shared by API + scheduler via `command`), `kiro-agent-planner`, `kiro-agent-coding`, `kiro-agent-fix`, `teams-gateway`.
4. **Kiro CLI only** in `hyperloop-agent-runtime` images. Control Plane and Event Gateway must never import or exec Kiro.
5. Control Plane creates Jobs and ingests agent result manifests; it does not run agent code in-process.
6. Contracts and infrastructure produce no runtime application images.

## Consequences

- Vertical-slice harnesses that called `runPlanner`/`runCoding` inside Control Plane move to workspace `e2e/`.
- Event Gateway owns webhook ingress; Control Plane consumes normalized SQS events.
- Role-specific agent images replace the single `kiro-agent` image.
