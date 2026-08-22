#!/usr/bin/env bash
# Installs the latest opencode-lowmem release binary from GitHub Releases.
# Safe by design: never kills running sessions; installs to ~/.opencode/bin only.
set -euo pipefail

REPO="renekris/opencode-lowmem"
INSTALL_DIR="${HOME}/.opencode/bin"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}-${ARCH}" in
  Linux-x86_64) PLATFORM="opencode-linux-x64" ;;
  Linux-aarch64) PLATFORM="opencode-linux-arm64" ;;
  Darwin-arm64) PLATFORM="opencode-darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="opencode-darwin-x64" ;;
  *)
    echo "Unsupported platform: ${OS}-${ARCH}" >&2
    echo "Download manually: https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

if command -v gh >/dev/null 2>&1; then
  TAG="$(gh release list --repo "${REPO}" --limit 1 --json tagName --jq '.[0].tagName')"
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
fi
if [ -z "${TAG}" ]; then
  echo "Could not determine the latest release tag." >&2
  exit 1
fi

ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${PLATFORM}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Installing ${TAG} (${PLATFORM}) to ${INSTALL_DIR}"
curl -fsSL "${ASSET_URL}" | tar -xz -C "${TMP_DIR}"
mkdir -p "${INSTALL_DIR}"
mv "${TMP_DIR}/${PLATFORM}/bin/opencode" "${INSTALL_DIR}/opencode"
chmod +x "${INSTALL_DIR}/opencode"

echo "Installed: $("${INSTALL_DIR}/opencode" --version)"
echo "Make sure ${INSTALL_DIR} is on your PATH."
