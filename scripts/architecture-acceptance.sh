#!/usr/bin/env bash
# P11 — Section 0.7 architecture acceptance suite (static + unit/e2e gates).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAIL=1; }

echo "==> #1 Kiro only in agent-runtime (source scan)"
HITS="$(rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' \
  -e 'invokeKiro|execFile\(['\''\"]kiro|/bin/kiro|\bkiro\b' \
  hyperloop-control-plane/src hyperloop-integrations/src 2>/dev/null \
  | grep -v -E 'comment|SPIKE|KIRO_CLI|HYPERLOOP_KIRO|no Kiro|never.*[Kk]iro' || true)"
# Allow config/image name strings but not process invocation
PROC_HITS="$(rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' \
  -e 'invokeKiro|execFile\(['\''\"]kiro|spawn\(['\''\"]kiro' \
  hyperloop-control-plane/src hyperloop-integrations/src 2>/dev/null || true)"
if [[ -n "$PROC_HITS" ]]; then
  fail "#1 process-level Kiro references outside agent-runtime:"$'\n'"$PROC_HITS"
else
  pass "#1 no Kiro process invocation outside agent-runtime"
fi

echo "==> #2 Six image Dockerfiles present"
for f in \
  hyperloop-integrations/services/event-gateway/Dockerfile \
  hyperloop-control-plane/Dockerfile \
  hyperloop-agent-runtime/docker/Dockerfile.planner \
  hyperloop-agent-runtime/docker/Dockerfile.coding \
  hyperloop-agent-runtime/docker/Dockerfile.fix \
  hyperloop-teams-gateway/Dockerfile
do
  [[ -f "$f" ]] || fail "missing $f"
done
pass "#2 six Dockerfiles"

echo "==> #3 Four Deployments via helm template"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:$PATH"
if command -v helm >/dev/null && command -v yq >/dev/null; then
  RENDER="$(mktemp)"
  {
    helm template eg hyperloop-infrastructure/helm/event-gateway
    echo '---'
    helm template cp hyperloop-infrastructure/helm/control-plane
    echo '---'
    helm template tg hyperloop-infrastructure/helm/teams-gateway
    echo '---'
    helm template aj hyperloop-infrastructure/helm/agent-job
  } >"$RENDER"
  COUNT="$(yq 'select(.kind == "Deployment") | .metadata.name' "$RENDER" | grep -vE '^(---|null)?$' | sort -u | grep -c . || true)"
  AJ="$(helm template aj hyperloop-infrastructure/helm/agent-job | yq 'select(.kind == "Deployment") | .metadata.name' | grep -vE '^(---|null)?$' || true)"
  rm -f "$RENDER"
  [[ "$COUNT" -eq 4 ]] || fail "#3 expected 4 Deployments, got $COUNT"
  [[ -z "$AJ" ]] || fail "#3 agent-job emitted Deployment"
  pass "#3 exactly 4 Deployments; agent-job has none"
else
  echo "WARN: helm/yq missing — skip #3 live render"
fi

echo "==> #4–#8,#10–#12 unit/e2e gates"
(cd hyperloop-contracts && npm test --silent)
(cd hyperloop-control-plane && npm test --silent)
(cd hyperloop-agent-runtime && npm test --silent)
(cd hyperloop-integrations && npm test --silent)
(cd e2e && npm test --silent)
pass "#4–#12 package tests (planner/coding/fix/CI/MR/e2e)"

echo "==> #5 Planner cannot push (negative permission contract in code)"
rg -n 'createOrUpdateMr|pushCommit' hyperloop-agent-runtime/src/roles/planner >/dev/null && fail "#5 planner references push/MR" || pass "#5 planner has no push/MR APIs"

echo "==> #9 capacity integration (optional if DynamoDB Local up)"
if curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 http://127.0.0.1:18000/ 2>/dev/null | grep -qE '^[0-9]+$'; then
  if (cd e2e && AWS_ENDPOINT_URL=http://127.0.0.1:18000 npm run test:integration --silent); then
    pass "#9 capacity integration"
  else
    fail "#9 capacity integration failed"
  fi
else
  echo "WARN: DynamoDB Local not on :18000 — skip #9 (run: docker compose -f e2e/compose.yaml up -d)"
fi

echo "==> #12 no Jira/Confluence/Graphify runtime deps"
JIRA="$(rg -n --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/HYPERLOOP_CODEX_HANDOFF.md' --glob '!**/docs/**' \
  -e '\bJira\b|\bConfluence\b|\bGraphify\b' \
  hyperloop-control-plane/src hyperloop-agent-runtime/src hyperloop-integrations/src 2>/dev/null || true)"
if [[ -n "$JIRA" ]]; then
  fail "#12 forbidden external planning deps:"$'\n'"$JIRA"
else
  pass "#12 no Jira/Confluence/Graphify in runtime src"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "ARCHITECTURE ACCEPTANCE FAILED"
  exit 1
fi
echo "OK: P11 architecture acceptance"
