# Long-session candidate evidence

Status: release `1.18.29-lowmem.3` documentation and evidence prepared. The `.2`
publication was intentionally skipped to remove version ambiguity. Full build,
scoped validation, and RAM-increment review passed for the locally verified
`1.18.29-lowmem.2` binary. No `.3` binary is claimed until the isolated release build
completes. The `.2` binary was promoted to the local default on 2026-09-07 at the user's request after
their sustained trial. No session restart, live database access, or schema
migration.

The latest upstream check on 2026-09-07 found `v1.18.29` already merged. The
`.3` publication version is based on that upstream release. This document records
private local validation and promotion facts, not public installation paths or
instructions.

Release scope does not include a universal RSS cap, database retention or
migrations, or OMO modifications. Numeric sampling remains optional diagnostics,
not a process memory limit.

## Default promotion

The user reports approximately 2.5-3.5 GB during sustained use, with transient
spikes including 3 to 5 GB during task activity. This is user observation, not a
profile proving the spike's cause or a hard memory ceiling.

The verified binary was copied to a new sibling and atomically renamed onto
`/home/renekris/.opencode/bin/opencode`. Both `opencode --version` and
`oc --version` report `1.18.29-lowmem.2`; the installed SHA-256 matches below.
Existing processes retain their original executable inode and were not restarted.
The prior binary is preserved at
`/home/renekris/.opencode/bin/opencode.pre-lowmem2-20260907` (SHA-256
`829a3a955107bd792172a85292698c8028165d6fc9d3c3129ec1592a1ce6f360`).
Rollback, only on request, uses a fresh sibling copy and atomic rename, not an
in-place overwrite. Global auto-update remains disabled. The existing OMO
`oh-my-openagent@5.0.0-beta.46` plugin entry was left unchanged; the companion
local plugin is not globally enabled by this binary promotion. Numeric sampling
remains opt-in. The manual-trial instructions below describe the earlier trial.

Both the main review and final lifecycle-delta review approved this increment
for a controlled manual trial, not a claim that persistent RSS or DB growth is
fully solved. Final binary SHA-256:
`ba63d479f55ff2f56f4cd62c6197b0d01b900c21f47521f3e04a36371d7d4eae`.

Local functional commits: `5d40d60d56` (history selection/fork), `09c989d8cb`
(numeric diagnostics), and `c6a2a679b1` (pre-queue filtering). Companion OMO
commit: `811d62a40` on beta.46. No branches, tags, or packages were published.

## Manual trial boundary

The following is historical local-trial context for the `.2` binary and its
separate local OMO companion. It is not a public installation procedure for
`.3`.

Use the candidate binary only when the old process is idle and its delegated
work is settled. Close that old process yourself before reopening the same
session ID; do not run two processes against that session concurrently.
Do not replace or delete any database files. This round adds no migrations.

The OMO companion is a local beta.46 build. Replace the existing OMO entry in
the plugin list with the absolute file URL of the companion worktree's
`dist/index.js`; do not append a second OMO entry. Keep that worktree and its
runtime dependencies/assets available. No installed configuration has been
edited for you.

From the session's original project directory, invoke this worktree's new binary
by absolute path with `-s <session-id>`. Optionally set
`OPENCODE_MEMORY_STATS_PATH` to a distinct writable directory for this process
to collect the small role-separated numeric histories. These measurements will
be needed to determine whether any persistent runtime growth remains. The
source fixes do not imply a universal RSS ceiling.

## Final full-build verification

After the user reset their process, the host had 18 GiB available. The isolated
verification allowance was raised to 6 GiB hard / 5 GiB high, no swap, two CPUs,
and a 10 GiB available-memory admission check. Gates remained serialized. The
typechecker then completed in roughly 24 seconds at a measured 4.2 GiB RSS,
exposing owned fixture/Drizzle typing errors; all were fixed without assertions
or suppressions. `bun typecheck` in packages/opencode and packages/sdk/js pass.

Full native build command from packages/opencode: synthetic HOME/XDG roots,
OPENCODE_VERSION=1.18.29-lowmem.2, OPENCODE_CHANNEL=latest, OPENCODE_RELEASE unset,
NODE_OPTIONS=--max-old-space-size=4096, then
`bun run script/build.ts --single --skip-install`. The embedded Vite application
and native binary built successfully. Existing chunk/import warnings remain;
no UI source or build rule was changed. Version smoke reports 1.18.29-lowmem.2.

Final session-directory suite plus HTTP event and sampler tests:
441 pass, 7 existing skip, 1 existing todo, 0 fail, 1205 assertions in 81.33s
across 26 files. This broad existing suite intentionally exceeds the focused
30-second segment target; no new skip/todo or slow-test exception was added.

The real binary proof was rerun on the full build and additionally verified
embedded HTML and its referenced JavaScript asset return HTTP 200. The 205-message
reopen, OMO tail output, fork, and excluded malformed-part diff proofs pass.

Real PTY invocation (`script -q -e -c <binary> /dev/null`) in a fresh HOME/XDG root,
with OPENCODE_MEMORY_STATS_PATH scoped there, created tui.memory.json (250 bytes)
and server.memory.json (252 bytes). After the input rendered, Ctrl-D exited zero.
The initial proof sent Ctrl-D before input readiness and timed out; the proof
was corrected to await the real input, not by changing product behavior. Its
owned PTY/TUI and synthetic root were stopped/removed in finally.

The historical blockers below describe earlier attempts, not the current gates.

## Regressions

- Summary poison fixture: old full-history read failed parsing an unrelated
  malformed part; targeted SQL selection succeeds without hydrating that part.
- Exclusive fork fixture: old full-history read hydrated a malformed excluded
  boundary part; paged selection copies only preceding messages.
- Concurrent fork fixture: initial paged draft included 56 messages instead of
  the expected 55; fixed entry horizon excludes concurrent appends.
- Sampler overlap/failure fixtures: initial draft reproduced rename ENOENT and
  scheduled EISDIR; serialized sampling, explicit failure reporting, and awaited
  teardown pass. Real Bun numeric artifact generation also passes.
- Final focused invocation from packages/opencode used the resource wrapper
  and reported 73 pass, 0 fail, 178 assertions across six files in 9.04s:
  summary-selection, fork-pagination, summary-memory, messages-pagination,
  httpapi-event, and memory-stat tests.

## Real surface

QA-only binary: packages/opencode/dist/opencode-linux-x64/bin/opencode,
version 1.18.29-lowmem.2-qa, channel latest. Built with --single --skip-install
--skip-embed-web-ui inside synthetic HOME/XDG directories, under the same
2 GiB memory/zero-swap/serialized verification guard. Release upload disabled.

The parent-owned synthetic driver invoked the compiled binary and OMO's patched
formatter through the real SDK and API. It observed:

```text
PASS real OpenCode API -> OMO paged tail: 205 messages, last two correct
PASS real fork/diff ignore malformed excluded part; fork is exclusive and spans four pages
PASS synthetic import/reopen continuity; no live data or configuration accessed
TEARDOWN owned servers stopped and synthetic root removed
```

The synthetic source included 205 messages, mixed user/assistant turns and text
parts. After import and process restart, the paged reader returned only answers
203 and 204 with the correct total. After stopping the owned server, the driver
poisoned an excluded part in the synthetic database. A new server successfully
forked the first 200 messages and read the target turn's diff. All spawned
servers and the generated data root were removed in finally.

## Withheld changes and blockers

- SSE overflow/disconnection was withdrawn, including its experiment-only
  helper/tests, despite helper tests passing. The cited reconnecting UI clients
  use other endpoints; cli/cmd/run.ts consumes the changed instance endpoint
  without demonstrated missed-event recovery. Only safe pre-queue filtering
  and real HTTP/race regression coverage remain. No existing tests were removed.
- Two resource-capped OpenCode package typechecks did not complete within
  120s and 600s respectively. Neither is a pass. No third run, increased memory
  limit, type suppression, or LSP substitute was used.
- Full embedded-web build failed with V8 heap exhaustion. CLI-only QA success
  does not replace the missing full build. Final review/installation is blocked.
- No retention operation ran. Oracle's analysis correctly identified durable
  replay consumers, but its claim that deleting event rows alone resets the
  sequence was rejected: latestSequence reads event_sequence separately.
  Likewise, unmeasured database bytes cannot be asserted to be all live payload.
- No claim that the user's persistent 11 GiB RSS is already eliminated: the
  live process was explicitly excluded from measurement and changes this round.
