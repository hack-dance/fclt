#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if command -v vhs >/dev/null 2>&1; then
  cd "${REPO_ROOT}"
  exec vhs "${REPO_ROOT}/scripts/demo/readme-demo.tape"
fi

docker run --rm \
  -v "${REPO_ROOT}:/workspace" \
  -w /workspace \
  ghcr.io/charmbracelet/vhs \
  /workspace/scripts/demo/readme-demo.tape
