#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="hack-dance"
REPO_NAME="facult"

INSTALL_DIR="${FACULT_INSTALL_DIR:-$HOME/.facult/bin}"
REQUESTED_VERSION="${FACULT_VERSION:-latest}"
DOWNLOAD_RETRIES="${FACULT_DOWNLOAD_RETRIES:-12}"
DOWNLOAD_RETRY_DELAY_SECONDS="${FACULT_DOWNLOAD_RETRY_DELAY_SECONDS:-5}"

resolve_github_token() {
  if [[ -n "${FACULT_GITHUB_TOKEN:-}" ]]; then
    echo "$FACULT_GITHUB_TOKEN"
    return
  fi
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "$GITHUB_TOKEN"
    return
  fi
  if [[ -n "${GH_TOKEN:-}" ]]; then
    echo "$GH_TOKEN"
    return
  fi
  echo ""
}

detect_platform() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    darwin) echo "darwin" ;;
    linux) echo "linux" ;;
    *)
      echo "Unsupported OS: $os" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  local platform="$1"
  local arch
  arch="$(uname -m)"
  case "${platform}/${arch}" in
    darwin/x86_64|darwin/amd64) echo "x64" ;;
    darwin/arm64|darwin/aarch64) echo "arm64" ;;
    linux/x86_64|linux/amd64) echo "x64" ;;
    *)
      echo "Unsupported platform/architecture: ${platform}/${arch}" >&2
      echo "Prebuilt binaries are currently available for: darwin/{x64,arm64}, linux/x64, windows/x64" >&2
      exit 1
      ;;
  esac
}

resolve_tag() {
  if [[ "$REQUESTED_VERSION" == "latest" ]]; then
    local latest_url
    latest_url="$(curl "${CURL_AUTH_ARGS[@]}" -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest")"
    basename "$latest_url"
    return
  fi

  if [[ "$REQUESTED_VERSION" == v* ]]; then
    echo "$REQUESTED_VERSION"
  else
    echo "v${REQUESTED_VERSION}"
  fi
}

GITHUB_AUTH_TOKEN="$(resolve_github_token)"
CURL_AUTH_ARGS=()
if [[ -n "$GITHUB_AUTH_TOKEN" ]]; then
  CURL_AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_AUTH_TOKEN}")
fi

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch "$PLATFORM")"
TAG="$(resolve_tag)"
VERSION="${TAG#v}"
ASSET_NAME="facult-${VERSION}-${PLATFORM}-${ARCH}"
ASSET_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/${ASSET_NAME}"

mkdir -p "$INSTALL_DIR"
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/facult.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

echo "Downloading ${ASSET_NAME} from ${TAG}..."
attempt=1
while true; do
  if curl "${CURL_AUTH_ARGS[@]}" -fsSL "$ASSET_URL" -o "$TMP_FILE"; then
    break
  fi
  if [[ "$attempt" -ge "$DOWNLOAD_RETRIES" ]]; then
    echo "Failed to download ${ASSET_URL} after ${DOWNLOAD_RETRIES} attempts." >&2
    exit 1
  fi
  sleep "$DOWNLOAD_RETRY_DELAY_SECONDS"
  attempt=$((attempt + 1))
done
chmod +x "$TMP_FILE"
mv "$TMP_FILE" "${INSTALL_DIR}/facult"

mkdir -p "$HOME/.facult"
cat > "$HOME/.facult/install.json" <<EOF
{
  "version": 1,
  "method": "release-script",
  "packageVersion": "${VERSION}",
  "binaryPath": "${INSTALL_DIR}/facult",
  "source": "github-release",
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "Installed facult ${VERSION} to ${INSTALL_DIR}/facult"
echo "If needed, add this to your shell profile:"
echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
