# Contract versioning

- Schema files use `$id` URIs under `https://hyperloop.dev/schemas/`.
- Event types are versioned in the name suffix (`.v1`).
- Envelope field `schemaVersion` is currently fixed to `1.0.0`.
- Breaking changes require a new schema file / event type version and compatibility tests.
- Non-breaking additive optional fields may land in the same major schema with updated examples.

## Compatibility rules

1. Consumers must ignore unknown optional fields.
2. Producers must not remove or rename required fields without a new major version.
3. Freeze v1 schemas before integrating Control Plane and Agent Runtime.

## Changelog

### 2026-10-27 — AgentExecutionContract v2 (v1.3)

`agent-job-request.schema.json` is the Agent Execution Contract:

- Required: `executionId`, `role`, `sddRepository`, `sddCommitSha`, `devSpecPath`,
  `artifactPrefixUri`, `fenceToken`, `leaseExpiresAt` (plus prior job identity fields).
- `stage` remains as a **deprecated alias** of `role` (when both present, consumers must
  treat mismatch as invalid even if schema accepts).
- Role conditionals: planner must omit coding scope fields; coding/fix require
  repository, branch contract, approved plan hash/URI, and `expectedBaseSha`;
  fix also requires `failedCommitSha`, `ciReportUri`, `fixAttempt` ∈ {1,2}.
