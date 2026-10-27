#!/usr/bin/env bash
# Build the six v1.3 application images locally (monorepo root context).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

VERSION="${VERSION:-0.1.0}"
REVISION="${REVISION:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
KIRO_CLI_VERSION="${KIRO_CLI_VERSION:-unpinned}"
TAG_SUFFIX="${TAG_SUFFIX:-local}"

echo "==> base (KIRO_CLI_VERSION=${KIRO_CLI_VERSION})"
docker build \
  -f hyperloop-agent-runtime/docker/Dockerfile.base \
  --build-arg KIRO_CLI_VERSION="${KIRO_CLI_VERSION}" \
  --build-arg VERSION="${VERSION}" \
  --build-arg REVISION="${REVISION}" \
  -t "hyperloop/kiro-agent-base:${TAG_SUFFIX}" \
  .

for role in planner coding fix; do
  echo "==> kiro-agent-${role}"
  docker build \
    -f "hyperloop-agent-runtime/docker/Dockerfile.${role}" \
    --build-arg BASE_IMAGE="hyperloop/kiro-agent-base:${TAG_SUFFIX}" \
    --build-arg VERSION="${VERSION}" \
    --build-arg REVISION="${REVISION}" \
    -t "hyperloop/kiro-agent-${role}:${TAG_SUFFIX}" \
    .
done

echo "==> event-gateway"
docker build \
  -f hyperloop-integrations/services/event-gateway/Dockerfile \
  --build-arg VERSION="${VERSION}" \
  --build-arg REVISION="${REVISION}" \
  -t "hyperloop/event-gateway:${TAG_SUFFIX}" \
  .

echo "==> control-plane"
docker build \
  -f hyperloop-control-plane/Dockerfile \
  --build-arg VERSION="${VERSION}" \
  --build-arg REVISION="${REVISION}" \
  -t "hyperloop/control-plane:${TAG_SUFFIX}" \
  .

echo "==> teams-gateway"
docker build \
  -f hyperloop-teams-gateway/Dockerfile \
  --build-arg VERSION="${VERSION}" \
  --build-arg REVISION="${REVISION}" \
  -t "hyperloop/teams-gateway:${TAG_SUFFIX}" \
  .

echo "==> smoke"
uid="$(docker run --rm --entrypoint id "hyperloop/kiro-agent-planner:${TAG_SUFFIX}" -u)"
test "${uid}" != "0"
docker run --rm --entrypoint sh "hyperloop/control-plane:${TAG_SUFFIX}" -c '! command -v kiro'
docker run --rm --entrypoint sh "hyperloop/event-gateway:${TAG_SUFFIX}" -c '! command -v kiro'
docker run --rm -e HYPERLOOP_JOB_ID=smoke "hyperloop/kiro-agent-planner:${TAG_SUFFIX}" \
  | tee /tmp/hl-planner-smoke.log
grep -q 'image_role=planner' /tmp/hl-planner-smoke.log

# Role mismatch must fail
if docker run --rm -e HYPERLOOP_ROLE=coding "hyperloop/kiro-agent-planner:${TAG_SUFFIX}"; then
  echo "expected role mismatch to fail" >&2
  exit 1
fi

echo "OK: six images tagged :${TAG_SUFFIX}"
