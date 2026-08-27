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
MUSL_LOADER_x86="/lib/ld-musl-x86_64.so.1"
MUSL_LOADER_arm="/lib/ld-musl-aarch64.so.1"
if [ "${OS}" = "Linux" ] && { { [ "${ARCH}" = "x86_64" ] && [ -e "${MUSL_LOADER_x86}" ]; } || { [ "${ARCH}" = "aarch64" ] && [ -e "${MUSL_LOADER_arm}" ]; }; }; then
  PLATFORM="${PLATFORM}-musl"
fi

TAG=""
if command -v gh >/dev/null 2>&1; then
  TAG="$(gh release list --repo "${REPO}" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
fi
if [ -z "${TAG}" ]; then
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
curl -fsSL "${ASSET_URL}" -o "${TMP_DIR}/asset.tar.gz"
curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" -o "${TMP_DIR}/release.json"
EXPECTED="$(python3 -c "
import json,sys
release=json.load(open('${TMP_DIR}/release.json'))
for a in release.get('assets',[]):
    if a['name']=='${PLATFORM}.tar.gz': print(a.get('digest','').replace('sha256:','')); break
")"
if [ -n "${EXPECTED}" ]; then
  ACTUAL="$(sha256sum "${TMP_DIR}/asset.tar.gz" | cut -d' ' -f1)"
  if [ "${ACTUAL}" != "${EXPECTED}" ]; then
    echo "Checksum mismatch for ${PLATFORM}.tar.gz (want ${EXPECTED}, got ${ACTUAL})" >&2
    exit 1
  fi
else
  echo "Refusing to install: no digest published for ${PLATFORM}.tar.gz (release assets must carry sha256 digests)" >&2
  exit 1
fi
tar -xzf "${TMP_DIR}/asset.tar.gz" -C "${TMP_DIR}"
mkdir -p "${INSTALL_DIR}"
# Publish via a same-directory rename: a cross-filesystem mv from /tmp would
# copy+unlink and leave a truncated live binary if interrupted. mktemp keeps
# the staging name unpredictable so a pre-planted symlink cannot redirect cp.
INSTALL_TMP="$(mktemp "${INSTALL_DIR}/opencode-install.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"; rm -f "${INSTALL_TMP}"' EXIT
cp "${TMP_DIR}/${PLATFORM}/bin/opencode" "${INSTALL_TMP}"
chmod +x "${INSTALL_TMP}"
mv -f "${INSTALL_TMP}" "${INSTALL_DIR}/opencode"

echo "Installed: $("${INSTALL_DIR}/opencode" --version)"
echo "Make sure ${INSTALL_DIR} is on your PATH."
