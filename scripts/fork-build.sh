#!/usr/bin/env bash
# fork-build.sh — build the resource-bounded opencode fork with a correct version stamp.
set -euo pipefail

FLAVOR="lowmem"
CHANNEL="latest" # MANDATORY: any other value makes the binary open opencode-<channel>.db instead of opencode.db
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLATFORM_BIN="dist/opencode-linux-x64/bin/opencode"

cd "$ROOT"

# Exclude fork tags: after a fresh upstream merge the previous fork tag can tie
# the new upstream tag on commit distance with a newer date, winning describe.
BASE="$(git describe --tags --abbrev=0 --exclude "*-${FLAVOR}.*" 2>/dev/null | sed -e 's/^v//' -e "s/-${FLAVOR}\.[0-9]*\$//")"
if [[ -z "$BASE" || "$BASE" == *"-${FLAVOR}"* ]]; then
  echo "fork-build: cannot determine upstream base tag from $(git describe --tags --abbrev=0 2>/dev/null || echo '<none>')" >&2
  exit 1
fi
LAST_ROUND="$(git tag -l "v${BASE}-${FLAVOR}.*" | sed -e "s/^v${BASE}-${FLAVOR}\.//" | sort -n | tail -1)"
ROUND="$(( ${LAST_ROUND:-0} + 1 ))"
STAMP="${BASE}-${FLAVOR}.${ROUND}"

echo "==> building opencode ${STAMP} (channel=${CHANNEL})"
( cd packages/opencode && OPENCODE_VERSION="${STAMP}" OPENCODE_CHANNEL="${CHANNEL}" bun run build )

BIN="${ROOT}/packages/opencode/${PLATFORM_BIN}"
OUT="$("${BIN}" --version)"
if [[ "${OUT}" != "${STAMP}" ]]; then
  echo "fork-build: smoke test failed: binary reports '${OUT}', expected '${STAMP}'" >&2
  exit 1
fi

SHIM="${HOME}/.opencode/bin/opencode"
# Deliberate out-of-band shim management may set this escape hatch to 1.
ALLOW_SHIM_MISMATCH="${OPENCODE_FORK_BUILD_ALLOW_SHIM_MISMATCH:-0}"
SHIM_MISMATCH_ACCEPTED=0
if [[ -f "${SHIM}" ]]; then
  echo "==> shim exists at ${SHIM} (left untouched)"
  if ! grep -qF "${BIN}" "${SHIM}"; then
    if [[ "${ALLOW_SHIM_MISMATCH}" != "1" ]]; then
      echo "fork-build: shim does not reference ${BIN}; set OPENCODE_FORK_BUILD_ALLOW_SHIM_MISMATCH=1 only for deliberate out-of-band shim management" >&2
      exit 1
    fi
    SHIM_MISMATCH_ACCEPTED=1
    echo "!! shim does not reference ${BIN} — mismatch explicitly allowed"
  fi
else
  mkdir -p "$(dirname "${SHIM}")"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BIN}" > "${SHIM}"
  chmod +x "${SHIM}"
  echo "==> wrote shim ${SHIM} -> ${BIN}"
fi

SHIM_OUT="$("${SHIM}" --version)"
if [[ "${SHIM_OUT}" != "${STAMP}" ]]; then
  if [[ "${ALLOW_SHIM_MISMATCH}" != "1" ]]; then
    echo "fork-build: shim reports '${SHIM_OUT}', expected '${STAMP}'" >&2
    exit 1
  fi
  SHIM_MISMATCH_ACCEPTED=1
  echo "!! shim reports '${SHIM_OUT}', expected '${STAMP}' — mismatch explicitly allowed"
else
  echo "==> verified shim version ${SHIM_OUT}"
fi
if [[ "${SHIM_MISMATCH_ACCEPTED}" == "1" ]]; then
  echo "==> tagging ${STAMP}; shim mismatch escape hatch accepted, promotion proceeds with warning"
else
  echo "==> tagging ${STAMP}; build and shim checks passed"
fi
git tag "v${STAMP}"
echo "==> done: ${STAMP}"
