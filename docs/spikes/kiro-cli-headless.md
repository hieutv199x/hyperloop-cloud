# Spike: Kiro CLI headless (P10 blocker)

**Status:** Open  
**Blocks:** Real `kiro` install in agent images (`docker/install-kiro.sh`), production Planner/Coding/Fix execution.

## Must verify inside the base image

1. Exact package / version string for Kiro CLI
2. Official install method (no invented URLs)
3. Headless invocation flags and exit codes
4. Authentication / identity for Kiro
5. Structured output format for planner and coding

Until verified, build agent images with:

```bash
KIRO_CLI_VERSION=unpinned ./scripts/build-images.sh
```

That produces images **without** a `kiro` binary and writes `/opt/hyperloop/KIRO_SPIKE_BLOCKER`.
