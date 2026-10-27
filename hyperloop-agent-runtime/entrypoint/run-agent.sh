#!/usr/bin/env bash
set -euo pipefail

IMAGE_ROLE="${HYPERLOOP_IMAGE_ROLE:-}"
RUNTIME_ROLE="${HYPERLOOP_ROLE:-${HYPERLOOP_STAGE:-}}"

echo "[hyperloop-agent] starting image_role=${IMAGE_ROLE:-unset} runtime_role=${RUNTIME_ROLE:-unset} job=${HYPERLOOP_JOB_ID:-unknown}"

if [[ -n "${IMAGE_ROLE}" && -n "${RUNTIME_ROLE}" && "${IMAGE_ROLE}" != "${RUNTIME_ROLE}" ]]; then
  echo "[hyperloop-agent] refusing mismatched role: image=${IMAGE_ROLE} runtime=${RUNTIME_ROLE}" >&2
  exit 64
fi

cleanup() {
  echo "[hyperloop-agent] received signal, exiting gracefully"
}
trap cleanup SIGTERM SIGINT

exec node /app/dist/main/job.js
