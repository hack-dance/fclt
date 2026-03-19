#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="hack-dance"
REPO_NAME="facult"
CLI_NAME="fclt"
COMPATIBILITY_NAME="facult"

INSTALL_DIR="${FACULT_INSTALL_DIR:-$HOME/.ai/.facult/bin}"
REQUESTED_VERSION="${FACULT_VERSION:-latest}"
DOWNLOAD_RETRIES="${FACULT_DOWNLOAD_RETRIES:-12}"
DOWNLOAD_RETRY_DELAY_SECONDS="${FACULT_DOWNLOAD_RETRY_DELAY_SECONDS:-5}"

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
    latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest")"
    basename "$latest_url"
    return
  fi

  if [[ "$REQUESTED_VERSION" == v* ]]; then
    echo "$REQUESTED_VERSION"
  else
    echo "v${REQUESTED_VERSION}"
  fi
}

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch "$PLATFORM")"
TAG="$(resolve_tag)"
VERSION="${TAG#v}"
PRIMARY_ASSET_NAME="${CLI_NAME}-${VERSION}-${PLATFORM}-${ARCH}"
PRIMARY_ASSET_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/${PRIMARY_ASSET_NAME}"
COMPATIBILITY_ASSET_NAME="${COMPATIBILITY_NAME}-${VERSION}-${PLATFORM}-${ARCH}"
COMPATIBILITY_ASSET_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/${COMPATIBILITY_ASSET_NAME}"

mkdir -p "$INSTALL_DIR"
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/fclt.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

echo "Downloading ${PRIMARY_ASSET_NAME} from ${TAG}..."
attempt=1
while true; do
  if curl -fsSL "$PRIMARY_ASSET_URL" -o "$TMP_FILE"; then
    break
  fi
  if curl -fsSL "$COMPATIBILITY_ASSET_URL" -o "$TMP_FILE"; then
    break
  fi
  if [[ "$attempt" -ge "$DOWNLOAD_RETRIES" ]]; then
    echo "Failed to download ${PRIMARY_ASSET_URL} after ${DOWNLOAD_RETRIES} attempts." >&2
    exit 1
  fi
  sleep "$DOWNLOAD_RETRY_DELAY_SECONDS"
  attempt=$((attempt + 1))
done
chmod +x "$TMP_FILE"
mv "$TMP_FILE" "${INSTALL_DIR}/${CLI_NAME}"
cp "${INSTALL_DIR}/${CLI_NAME}" "${INSTALL_DIR}/${COMPATIBILITY_NAME}"
chmod +x "${INSTALL_DIR}/${COMPATIBILITY_NAME}"

mkdir -p "$HOME/.ai/.facult"
cat > "$HOME/.ai/.facult/install.json" <<EOF
{
  "version": 1,
  "method": "release-script",
  "packageVersion": "${VERSION}",
  "binaryPath": "${INSTALL_DIR}/${CLI_NAME}",
  "source": "github-release",
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

echo "Installed fclt ${VERSION} to ${INSTALL_DIR}/${CLI_NAME}"
echo "If needed, add this to your shell profile:"
echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
