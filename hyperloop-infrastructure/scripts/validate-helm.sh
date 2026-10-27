#!/usr/bin/env bash
# P6 gate helper — lint, template, count Deployments, terraform validate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHARTS=(helm/event-gateway helm/control-plane helm/teams-gateway helm/agent-job)

echo "==> helm lint"
for c in "${CHARTS[@]}"; do
  helm lint "$c"
done

RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT

echo "==> helm template"
{
  helm template eg helm/event-gateway
  echo "---"
  helm template cp helm/control-plane
  echo "---"
  helm template tg helm/teams-gateway
  echo "---"
  helm template aj helm/agent-job
} >"$RENDER"

echo "==> kubeconform"
if command -v kubeconform >/dev/null 2>&1; then
  kubeconform -strict -ignore-missing-schemas "$RENDER"
else
  echo "WARN: kubeconform not installed; skipped"
fi

echo "==> Deployment count (expect 4)"
DEPLOYS="$(yq 'select(.kind == "Deployment") | .metadata.name' "$RENDER" | grep -vE '^(---|null)?$' | sort -u)"
echo "$DEPLOYS"
COUNT="$(printf '%s\n' "$DEPLOYS" | grep -c . || true)"
if [[ "$COUNT" -ne 4 ]]; then
  echo "FAIL: expected 4 Deployments, got $COUNT" >&2
  exit 1
fi
for name in control-plane-api control-plane-scheduler event-gateway teams-gateway; do
  printf '%s\n' "$DEPLOYS" | grep -qx "$name" || {
    echo "FAIL: missing Deployment $name" >&2
    exit 1
  }
done

echo "==> agent-job must not emit Deployments"
AJ_DEPLOYS="$(helm template aj helm/agent-job | yq 'select(.kind == "Deployment") | .metadata.name' | grep -vE '^(---|null)?$' || true)"
if [[ -n "$AJ_DEPLOYS" ]]; then
  echo "FAIL: agent-job emitted Deployments: $AJ_DEPLOYS" >&2
  exit 1
fi

echo "==> terraform validate"
terraform -chdir=terraform/aws init -backend=false -input=false >/dev/null
terraform -chdir=terraform/aws validate

echo "OK: P6 helm/terraform gate"
