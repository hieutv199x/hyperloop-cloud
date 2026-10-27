# Spike: Kiro CLI headless (P10)

**Status:** BLOCKED — external facts not available in this environment  
**Date:** 2026-10-27  
**Blocks:** Real `kiro` install in agent images (`docker/install-kiro.sh`), production Planner/Coding/Fix when `HYPERLOOP_KIRO_MODE=real`.

## Verification checklist (must be filled inside the Nexus base image)

| # | Item | Result |
|---|---|---|
| 1 | Exact package / version string | **UNKNOWN** — do not invent |
| 2 | Official install method / URL | **UNKNOWN** — `install-kiro.sh` refuses without `KIRO_CLI_VERSION` |
| 3 | Headless invocation flags | **UNKNOWN** — runner accepts `HYPERLOOP_KIRO_ARGS` JSON array once known |
| 4 | Exit codes | Assumed: `0` success; non-zero failure (to confirm) |
| 5 | Auth / identity | **UNKNOWN** — IRSA/secret mount TBD |
| 6 | Structured stdout schema | Contract: JSON with `files` + `summary` (coding/fix) or implementation-spec (planner) |

## Interim build

```bash
KIRO_CLI_VERSION=unpinned ./scripts/build-images.sh
```

Produces images **without** a `kiro` binary and writes `/opt/hyperloop/KIRO_SPIKE_BLOCKER`.

## Runtime modes

| `HYPERLOOP_KIRO_MODE` | Behavior |
|---|---|
| `simulate` (default in tests / unpinned images) | Deterministic local builders; no `kiro` process |
| `real` | `execFile('kiro', args)` via `runner/kiro-cli.ts`; fails closed if binary/flags missing |

## Contract for fake-binary tests

A stub `kiro` on `PATH` that:

1. Writes a JSON object to stdout (scrubbed secrets never echoed).
2. Exits `0` on success.
3. Responds to SIGTERM by exiting non-zero promptly.
