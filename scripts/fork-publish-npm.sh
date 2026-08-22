#!/usr/bin/env bash
# fork-publish-npm.sh — assemble (and optionally publish) npm packages from dist/.
#
# Layout mirrors the esbuild/@biomejs pattern:
#   opencode-lowmem              main package: bin shim + optionalDependencies on all platforms
#   opencode-lowmem-<platform>   12 platform packages: the compiled binary, with os/cpu gates
#
# Version = the lowmem stamp (e.g. 1.18.21-lowmem.6) — valid semver prerelease, and
# ordering works: 1.18.22-lowmem.1 > 1.18.21-lowmem.99.
#
# Usage:
#   scripts/fork-publish-npm.sh            assemble into staging + print the publish commands
#   scripts/fork-publish-npm.sh --publish  assemble and actually publish (needs npm auth)
set -euo pipefail

PUBLISH=0
[[ "${1:-}" == "--publish" ]] && PUBLISH=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAMP="$(git describe --tags --abbrev=0 | sed 's/^v//')"
# Fail closed if the stamp is not valid semver (e.g. upstream changes its scheme).
if ! node -e "const [v]=process.argv.slice(1);const m=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);if(!m)process.exit(1)" "$STAMP"; then
  echo "fork-publish-npm: stamp '${STAMP}' is not valid semver — refusing to publish broken versions" >&2
  exit 1
fi
CHANNEL="latest"
MAIN="opencode-lowmem"
PLATFORMS=(
  linux-x64 linux-x64-baseline linux-x64-musl linux-x64-baseline-musl
  linux-arm64 linux-arm64-musl darwin-x64 darwin-x64-baseline
  darwin-arm64 windows-x64 windows-x64-baseline windows-arm64
)

npm_os() { case "$1" in linux*) echo linux;; darwin*) echo darwin;; windows*) echo win32;; esac; }
npm_cpu() {
  case "$1" in
    *x64-baseline*) echo x64;; *x64*) echo x64;;
    *arm64*) echo arm64;;
  esac
}

STAGE="$(mktemp -d)/npm"
mkdir -p "${STAGE}"

# --- platform packages -------------------------------------------------------
for p in "${PLATFORMS[@]}"; do
  name="${MAIN}-${p}"
  dir="${STAGE}/${name}"
  mkdir -p "${dir}/bin"
  src="${ROOT}/packages/opencode/dist/opencode-${p}/bin/opencode"
  [[ "$p" == windows* ]] && src="${src}.exe"
  cp "${src}" "${dir}/bin/"
  cat > "${dir}/package.json" <<EOF
{
  "name": "${name}",
  "version": "${STAMP}",
  "description": "opencode-lowmem binary for ${p}",
  "license": "MIT",
  "repository": { "url": "git+https://github.com/renekris/opencode-lowmem.git" },
  "os": ["$(npm_os "$p")"],
  "cpu": ["$(npm_cpu "$p")"]
}
EOF
done

# --- main package --------------------------------------------------------------
dir="${STAGE}/${MAIN}"
mkdir -p "${dir}/bin"
cat > "${dir}/bin/opencode" <<'EOF'
#!/usr/bin/env node
// Resolves the platform binary installed as an optionalDependency and execs it.
const { spawn } = require("node:child_process")
const path = require("node:path")
const arch = process.arch === "x64" ? "x64" : process.arch
const suffix = `${process.platform}-${arch}`
// Prefer the exact match; baseline/musl variants exist for x64 linux.
const candidates =
  suffix === "linux-x64"
    ? ["linux-x64-musl", "linux-x64", "linux-x64-baseline-musl", "linux-x64-baseline"]
    : suffix === "darwin-x64"
      ? ["darwin-x64", "darwin-x64-baseline"]
      : [suffix]
for (const cand of candidates) {
  try {
    const bin = require.resolve(`opencode-lowmem-${cand}/bin/opencode${process.platform === "win32" ? ".exe" : ""}`)
    const child = spawn(bin, process.argv.slice(2), { stdio: "inherit" })
    child.on("exit", (code, signal) => process.exit(signal ? 128 + 1 : (code ?? 1)))
    return
  } catch {}
}
console.error(`opencode-lowmem: no binary found for ${suffix} (try reinstalling with npm)`)
process.exit(1)
EOF
chmod +x "${dir}/bin/opencode"

OPTS=""
for p in "${PLATFORMS[@]}"; do OPTS="${OPTS}\"${MAIN}-${p}\": \"${STAMP}\", "; done
OPTS="${OPTS%, }"
cat > "${dir}/package.json" <<EOF
{
  "name": "${MAIN}",
  "version": "${STAMP}",
  "description": "Resource-bounded build of opencode: same agent, bounded memory",
  "license": "MIT",
  "repository": { "url": "git+https://github.com/renekris/opencode-lowmem.git" },
  "bin": { "opencode": "bin/opencode" },
  "optionalDependencies": { ${OPTS} }
}
EOF
cat > "${dir}/README.md" <<'EOF'
# opencode-lowmem

Resource-bounded build of [opencode](https://github.com/anomalyco/opencode).
See https://github.com/renekris/opencode-lowmem for what the fork changes.
EOF

# --- publish or report ---------------------------------------------------------
echo "==> staged ${STAMP} in ${STAGE}"
for pkg in "${PLATFORMS[@]/#/${MAIN}-}" "${MAIN}"; do
  if [[ $PUBLISH == 1 ]]; then
    ( cd "${STAGE}/${pkg}" && npm publish --access public --tag latest )
  else
    echo "npm publish --access public  # ${STAGE}/${pkg}"
  fi
done
