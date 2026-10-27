#!/usr/bin/env bash
# Fake kiro binary for P10 contract tests.
set -euo pipefail
if [[ "${1:-}" == "--hang" ]]; then
  trap 'exit 143' TERM
  while true; do sleep 1; done
fi
# Echo scrub-sensitive token then JSON payload
printf 'token=ghp_SHOULD_BE_SCRUBBED\n'
printf '{"files":{"ok.txt":"yes"},"summary":"fake-kiro-ok"}\n'
exit 0
