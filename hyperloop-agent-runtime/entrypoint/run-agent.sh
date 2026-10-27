#!/usr/bin/env bash
set -euo pipefail

echo "[hyperloop-agent] starting stage=${HYPERLOOP_STAGE:-planner} job=${HYPERLOOP_JOB_ID:-unknown}"

cleanup() {
  echo "[hyperloop-agent] received signal, exiting gracefully"
}
trap cleanup SIGTERM SIGINT

exec node /app/dist/index.js
