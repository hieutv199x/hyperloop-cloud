# ADR 0002: Self-contained SDD-only planning (handoff v1.2)

**Status:** Accepted  
**Date:** 2026-10-27  
**Context:** Supersedes planning assumptions in ADR 0001 that implied external Graphify/Jira/Confluence runtime context. Authoritative source: `HYPERLOOP_CODEX_HANDOFF.md` Section 15.

## Decision

1. Planner runtime context is **only** the pinned `*-sdd` Git commit SHA.
2. Missing required SDD documents/services/branches → `NEEDS_SPEC_CLARIFICATION`; **do not** schedule Planner.
3. Planner cannot widen executable service scope beyond SDD declarations.
4. HITL binds `(workflowId, sddCommitSha, implementationPlanHash)`.
5. Relevant SDD revisions supersede stale plans/approvals and **fence** obsolete Coding/Fix pushes.
6. M1.5 100-slot scheduler, Kiro-only agents, Jenkins, and two auto-fix attempts remain unchanged.

## Consequences

- Contracts gain `sdd-manifest.schema.json` and related events/types.
- Control Plane gains `sdd/` + `planning/` modules before expanding M2 planner behavior.
- Agent Planner loads SDD package only; source-repo checkout stays Coding/Fix.
