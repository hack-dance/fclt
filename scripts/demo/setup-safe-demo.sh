#!/usr/bin/env bash
set -euo pipefail

DEMO_ROOT="${1:-/tmp/fclt-demo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUN_BIN="$(mise which bun 2>/dev/null || command -v bun || true)"

if [[ -z "${BUN_BIN}" ]]; then
  echo "bun is required to build the demo environment" >&2
  exit 1
fi

rm -rf "${DEMO_ROOT}"
mkdir -p \
  "${DEMO_ROOT}/bin" \
  "${DEMO_ROOT}/cache" \
  "${DEMO_ROOT}/home" \
  "${DEMO_ROOT}/repo" \
  "${DEMO_ROOT}/state"

cat >"${DEMO_ROOT}/bin/fclt" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${BUN_BIN}" "${REPO_ROOT}/src/index.ts" "\$@"
EOF
chmod +x "${DEMO_ROOT}/bin/fclt"

cd "${DEMO_ROOT}/repo"
git init -q
git config user.name "Demo User"
git config user.email "demo@example.com"
echo "# fclt demo" > README.md
