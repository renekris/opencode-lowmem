#!/usr/bin/env bash
# fork-build.sh — build the resource-bounded opencode fork with a correct version stamp.
#
# What it does:
#   1. Derives the version stamp: <upstream-base>-<FLAVOR>.<round>, where <round> counts
#      prior builds of this base (tracked as local git tags) plus one.
#   2. Builds every platform target from packages/opencode.
#   3. Smoke-tests the linux-x64 binary's --version against the stamp.
#   4. Tags the repo so the next build increments the round.
#   5. Ensures ~/.opencode/bin/opencode execs this checkout's dist binary
#      (writes the shim only if missing; never touches an existing one).
#
# It never kills running opencode sessions: sessions exec the binary at launch, so a
# rebuild is picked up only by newly started sessions.
#
# FLAVOR rationale: "lowmem" states the fork's benefit literally — same features, less
# memory/disk waste (Debian lowmem-kernel heritage). Rejected alternates: bounded, capped
# (too abstract), lean, efficient, mem, slim/lite (collide with oh-my-opencode-* names).
set -euo pipefail

FLAVOR="lowmem"
CHANNEL="latest" # MANDATORY: any other value makes the binary open opencode-<channel>.db instead of opencode.db
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLATFORM_BIN="dist/opencode-linux-x64/bin/opencode"

cd "$ROOT"

BASE="$(git describe --tags --abbrev=0 2>/dev/null | sed -e 's/^v//' -e "s/-${FLAVOR}\.[0-9]*\$//")"
if [[ -z "$BASE" || "$BASE" == *"-${FLAVOR}"* ]]; then
  echo "fork-build: cannot determine upstream base tag from $(git describe --tags --abbrev=0 2>/dev/null || echo '<none>')" >&2
  exit 1
fi
COUNT="$(git tag -l "v${BASE}-${FLAVOR}.*" | /usr/bin/wc -l | tr -d ' ')"
ROUND="$((COUNT + 1))"
STAMP="${BASE}-${FLAVOR}.${ROUND}"

echo "==> building opencode ${STAMP} (channel=${CHANNEL})"
( cd packages/opencode && OPENCODE_VERSION="${STAMP}" OPENCODE_CHANNEL="${CHANNEL}" bun run build )

BIN="${ROOT}/packages/opencode/${PLATFORM_BIN}"
OUT="$("${BIN}" --version)"
if [[ "${OUT}" != "${STAMP}" ]]; then
  echo "fork-build: smoke test failed: binary reports '${OUT}', expected '${STAMP}'" >&2
  exit 1
fi
git tag "v${STAMP}"

SHIM="${HOME}/.opencode/bin/opencode"
if [[ -f "${SHIM}" ]]; then
  echo "==> shim exists at ${SHIM} (left untouched)"
  if ! grep -qF "${BIN}" "${SHIM}"; then
    echo "!! shim does not reference ${BIN} — review it manually" >&2
  fi
else
  mkdir -p "$(dirname "${SHIM}")"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "${BIN}" > "${SHIM}"
  chmod +x "${SHIM}"
  echo "==> wrote shim ${SHIM} -> ${BIN}"
fi
echo "==> done: ${STAMP}"
