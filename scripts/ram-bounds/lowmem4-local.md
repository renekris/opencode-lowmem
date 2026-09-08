# Local lowmem.4 candidate

Date: 2026-09-08. Version: `1.18.29-lowmem.4`, channel `latest`.
Status: initially installed as local default for the user's explicitly
authorized trial while the source was still uncommitted; the same patch is now
committed and published as the public `v1.18.29-lowmem.4` release (see the
public release section below).
The focused Oracle review was still running at promotion and subsequently
approved the narrow listener fix with no blocking findings (task `bg_9dafb57e`,
session `ses_f7f68ddb0ffebPtHzpHVmN6KhV`). Review checked subscriber lifetimes,
idempotent teardown, notification behavior, and regression-test coverage.
This approval does not establish a universal RAM bound.
Atomic rename replaced `~/.opencode/bin/opencode`; both `opencode --version` and
`oc --version` then returned `1.18.29-lowmem.4`. Existing sessions were untouched.
Rollback: `~/.opencode/bin/opencode.pre-lowmem4-20260908` retains .2. Restore only
on request through a fresh sibling copy followed by atomic rename.
Trial source: `c5623230b58460b321551bbff5cbe88a315063f8` plus the then-local
`packages/tui/src/context/event.ts` subscribe-time owner-cleanup patch. The
patch is now committed as `f1febb082262f7203be22bda31ef4c5c42600a45`
(`fix(tui): dispose event subscriptions with the owner`, source and regression
test together) and tagged `v1.18.29-lowmem.4`; the sections below were written
during the uncommitted-trial phase and remain accurate for it.

## Evidence

- Four listener tests pass, including keyed remount, manual unsubscribe,
  computation rerun, and ownerless lifetime. TUI package `bun run typecheck` passes.
- In a detached synthetic checkout, removing only the cleanup line makes the
  remount and computation tests fail (2 pass, 2 fail, 647 ms). Restoring the patch
  and including `test/app-lifecycle.test.tsx` gives 6 pass, 0 fail, 16 assertions,
  4.18 seconds. Detached-checkout TUI typecheck also passes.
- Full Linux x64 build with embedded web UI passes using `OPENCODE_VERSION=
  1.18.29-lowmem.4`, `OPENCODE_CHANNEL=latest`, `PYTHON=/usr/bin/python3`, and
  `bun run script/build.ts --single --skip-install` from `packages/opencode`.
  Existing dependency directories were symlinked into the detached checkout;
  no dependencies were installed or changed. Build warnings concerned chunking
  and an overwritten source-map asset; the build and native version smoke passed.
- `/tmp/opencode/long-session-tui.ts` exercised the candidate in an owned PTY,
  synthetic HOME/XDG/database: input ready, both role samplers started, Ctrl-D
  exited zero. The owned process and synthetic data were removed afterward.
- `/tmp/opencode/long-session-surface.ts` passed with the candidate and installed
  .2 binary: embedded HTML/JS, 205-message import/reopen and paged output,
  exclusive fork/diff excluding a malformed part, and .2 -> .4 -> .2 database
  compatibility. All data and server processes were synthetic and removed.
- Tests, typechecks, build, and PTY run used `/tmp/opencode/long-session-check.sh`:
  serialized, 10 GiB available-memory admission, 5 GiB high / 6 GiB hard memory
  bounds, zero swap, and two CPUs.

Candidate SHA256:
`c4bea397d27576e17321e4d6e3e7cc54dbf0306deb7e0e9d06319c1fe2c7e95d`.
Prior installed .2 SHA256:
`ba63d479f55ff2f56f4cd62c6197b0d01b900c21f47521f3e04a36371d7d4eae`.

Scope: fixes owner-scoped event-listener accumulation, not a universal RAM cap.
No live sessions, live database, history limits, or OMO configuration were changed.

## Public `1.18.29-lowmem.4` release build

The uncommitted trial patch above is committed as
`f1febb082262f7203be22bda31ef4c5c42600a45` with its
`packages/tui/test/context/event.test.tsx` suite. The public release was built
from that commit in a new detached worktree
(`/tmp/opencode/lowmem4-release-wt`); the earlier synthetic trial checkout
`/tmp/opencode/lowmem4-build` was not touched. Frozen workspace install plus
the build's own all-platform native installs used `PYTHON=/usr/bin/python3`.
Command from `packages/opencode`: `OPENCODE_VERSION=1.18.29-lowmem.4
OPENCODE_CHANNEL=latest NODE_OPTIONS=--max-old-space-size=4096
PYTHON=/usr/bin/python3 bun run script/build.ts`, with `OPENCODE_RELEASE`
unset, under the guard (10 GiB MemAvailable admission, 5 GiB high / 6 GiB hard,
zero swap, two CPUs). Exit 0.

- Focused regressions at the commit: 6 pass, 0 fail, 16 assertions
  (`test/context/event.test.tsx` + `test/app-lifecycle.test.tsx`), TUI
  `tsgo --noEmit` clean. The remove-cleanup/restore regression cycle (2
  expected failures, then 6 passes) was recorded earlier from identical source;
  no source change has happened since.
- All 12 targets built with the embedded web UI; native Linux x64 and baseline
  smokes report `1.18.29-lowmem.4`. Cross-compiled platforms were not executed
  on native hardware.
- Release Linux x64 binary SHA-256:
  `d59478091e742d3a96de3ba6d353052fe36ba4267a3b9cbf0daf600637cf9897`. The
  installed trial binary
  (`c4bea397d27576e17321e4d6e3e7cc54dbf0306deb7e0e9d06319c1fe2c7e95d`) differs
  by build, not source, and remains the local default; it was not replaced
  during the release.
- Real PTY run on the release binary: both numeric recorders started, Ctrl-D
  exited zero. Surface checks with the release binary and the installed `.4`:
  embedded web HTML/JS served, 205-message import/reopen with paged tail,
  exclusive fork/diff excluding a malformed part, and installed-`.4` ->
  release -> installed-`.4` synthetic-database compatibility. All proof-owned
  processes and synthetic roots were removed.
- Packaging matches `1.18.29-lowmem.3`: 9 tarballs and 3 zips with
  `<platform>/package.json` + `<platform>/bin/opencode[.exe]`, plus
  SHA256SUMS. Recorded warnings: Vite dynamic-import/static-import chunking
  notes, chunks over 500 kB, and one overwritten `wasm-*.js.map` source-map
  asset, the same classes as prior rounds.
- Tag placement: `v1.18.29-lowmem.4` marks the documentation commit that
  follows the fix commit; only README and this evidence file changed after the
  matrix build, so the tagged tree compiles to the same binaries.
