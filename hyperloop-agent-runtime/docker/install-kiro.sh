#!/usr/bin/env bash
# Kiro CLI install gate (v1.3 §0.3 / P10 spike).
# Do NOT invent install URLs or headless flags here.
set -euo pipefail

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  echo "KIRO_CLI_VERSION build-arg is required (use 'unpinned' until P10 spike lands)" >&2
  exit 1
fi

mkdir -p /opt/hyperloop

if [[ "${VERSION}" == "unpinned" ]]; then
  cat >/opt/hyperloop/KIRO_SPIKE_BLOCKER <<'EOF'
Kiro CLI headless install is not pinned yet.
Complete docs/spikes/kiro-cli-headless.md (P10) before building with a real version.
This image intentionally does NOT contain a `kiro` binary.
EOF
  echo "Wrote /opt/hyperloop/KIRO_SPIKE_BLOCKER (KIRO_CLI_VERSION=unpinned)"
  exit 0
fi

cat >&2 <<EOF
Refusing to install Kiro CLI version '${VERSION}': install method and headless flags
are not verified. Pass KIRO_CLI_VERSION=unpinned for CI/local image builds, or
complete the P10 spike and update docker/install-kiro.sh with the official path.
EOF
exit 1
