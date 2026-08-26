# opencode-lowmem

**OpenCode for long, agent-heavy workdays.** If you keep many sessions open,
delegate to dozens of subagents, or leave the TUI running all day, this fork is
designed to stop old work from quietly consuming more and more memory and CPU.

It is still OpenCode: the same commands, sessions, auth, config, tools, and
plugins. The fork adds limits and cleanup around the places that grow during
heavy use. There is no database migration, and you can switch back to stock
OpenCode at any time.

### Try it

```bash
curl -fsSL https://raw.githubusercontent.com/renekris/opencode-lowmem/lowmem/scripts/fork-install.sh | bash
```

Start a new `opencode` session afterward. Existing sessions keep running their
current binary; new sessions use the lowmem build.

### What should feel different

| Heavy-workload problem | What this fork does |
| ---------------------- | ------------------- |
| Finished agents and old sessions stay resident | Evicts inactive payloads and old finished-agent tabs, then reloads them when needed |
| Long streamed answers get progressively more expensive | Coalesces text updates and removes quadratic delta concatenation |
| Compacted sessions reload too much history | Hydrates a recent window instead of materializing the whole session |
| Large edits and summaries carry huge patches | Caps snapshot patches and stores new summary diffs as metadata, recomputing content on demand |
| LSP files and diagnostics accumulate | Bounds document text, oversized-document records, and pull diagnostics by count and bytes |
| Event replay and background-job output spike memory | Pages durable events and keeps a bounded terminal-job ring |
| Idle state updates wake every client repeatedly | Deduplicates unchanged idle status broadcasts |

The goal is **bounded growth**, not a magic benchmark number. A fresh short
session may look similar to stock OpenCode; the difference becomes clearer as
sessions, agents, tool output, and edited files accumulate. Exact savings depend
on the workload, model output, plugins, and which UI you use.

The terminal TUI has the most complete set of bounds. Server-side fixes also
benefit `opencode serve`, web, desktop, and IDE clients. One pathological active
session can still exceed the documented allowances through fields that are not
yet capped; the exact remaining gaps are stated below rather than hidden.

The fork is built and dogfooded with the
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) plugin toolkit.

## Why this fork exists

One heavy delegation day: 50+ finished subagent tabs sitting in the UI forever,
a process that had crept past 12 GB inside a 28 GB WSL budget, and swap
doing overtime. The stale tabs were the visible symptom — underneath, every
compaction re-materialized full session histories, text deltas accumulated
quadratically (server- and UI-side), multi-megabyte diff patches rode every
update event, and finished streams kept their listeners alive.

Most fixes already existed as unmerged upstream PRs; the rest were small
bounds-oriented patches nobody had written. This fork ships all of them.

**This README is the single authoritative fork document.** It lists everything
shipped, who authored it, what was deliberately not taken, and how the fork is
maintained. Commit hashes are intentionally not listed (history consolidations
rewrite them) — find fork work with:

```bash
git log --grep '(port of upstream #42150)'        # a specific port
git log --oneline <base-tag>..HEAD -- <file-path> # everything touching a seam
# <base-tag> = the latest merged upstream release tag (the vX.Y.Z behind HEAD)
```

## Ported upstream fixes (never merged upstream)

| Fix                                 | Plain language                                                                                                                                                                                                                                                                      | Upstream                                                   | Author                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| Bounded compacted-history hydration | After context compaction, only the recent window loads; old history stays on disk until needed — a 609-message session materialized 11 MB, now ~0.8 MB                                                                                                                              | [#39930](https://github.com/anomalyco/opencode/pull/39930) | **brauliobo**             |
| O(N) delta accumulation             | Very long replies no longer get slower the longer they run (processor side)                                                                                                                                                                                                         | [#42150](https://github.com/anomalyco/opencode/pull/42150) | **hardes11**              |
| PubSub listener leak fix            | Subscriptions to finished streams are released (local deviation: listeners keep Array semantics so duplicate registrations deliver independently)                                                                                                                                   | [#38939](https://github.com/anomalyco/opencode/pull/38939) | **Shalin-Shah-2002**      |
| Config cache isolation              | Two projects open at once can't corrupt each other's settings                                                                                                                                                                                                                       | [#41950](https://github.com/anomalyco/opencode/pull/41950) | **weiconghe**             |
| Empty-stream retry                  | A gateway that closes cleanly with no content retries instead of silently ending your turn; we add a clean-EOF regression test and an observed-output guard so a stream that already emitted text is never retried                                                                  | [#43881](https://github.com/anomalyco/opencode/pull/43881) | **moritzscheele**         |
| Stream failures marked errored      | Failed streams are recorded as errored, not as normal stops                                                                                                                                                                                                                         | [#42176](https://github.com/anomalyco/opencode/pull/42176) | **vladislav-miroshnikov** |
| Honest SSE chunk timeout            | Server keepalive comments can't fake "data is flowing" during a stall; we add a multi-byte-split regression test                                                                                                                                                                    | [#43607](https://github.com/anomalyco/opencode/pull/43607) | **1052326311**            |
| PartUpdated shallow copy            | Parts stop being deep-cloned on every publish — a top RAM driver in long sessions (issue [#35107](https://github.com/anomalyco/opencode/issues/35107) by **xingruodong-sys**; fix shape from closed [#43733](https://github.com/anomalyco/opencode/pull/43733) by **ColeLindfors**) | #35107 / #43733                                            | credited here             |
| Idle status dedupe                  | Repeated "session is idle" writes stop re-broadcasting status events to every connected client — passive-CPU fix                                                                                                                                                                    | [#40984](https://github.com/anomalyco/opencode/pull/40984) | **zcxGGmu**               |
| Durable event codec reuse           | Event codecs are compiled once per definition and cached instead of being rebuilt on every encode/decode — cuts CPU and allocation churn on the hot event path (129 M read syscalls observed on a 2.5 h session)                                                                     | [#43778](https://github.com/anomalyco/opencode/pull/43778) | opencode-agent[bot]\*      |
| Database stats + vacuum subcommands (partial port) | Adds `opencode db stats [--json] [--exhaustive]` and `opencode db vacuum`; the stats implementation is a partial port of the upstream command shape, while this fork's offline vacuum guard is documented under customs below. Default stats read only cheap metadata (page counts, freelist, sidecar sizes, table names — no table scans). `--exhaustive` additionally reports per-table row counts and approximate payload bytes by scanning the full database. Stats read a read-only immutable view of the main database file (no locks, no sidecar writes); page/table values exclude uncheckpointed WAL contents, which `wal_bytes` reports separately | [#43456](https://github.com/anomalyco/opencode/pull/43456) | **AndyS77** |
| Write-only summary diff patches  | New message summaries retain file/count/status metadata without patch text; recomputation returns available patch content, subject to the existing snapshot diff limits, while pruned snapshots fall back to metadata; zero migration and historical events untouched | [#40861](https://github.com/anomalyco/opencode/pull/40861) | **KirillDeviatka** |

Each port commit carries a `(port of upstream #NNNNN)` trailer — never dropped.
\*AI-authored upstream PR; credited here in prose only.

## Original fork work (customs)

| Feature                      | Plain language                                                                                                                                                                                                                                                                                                                     | Detail                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Diff-patch caps              | Snapshots of large edits can't balloon memory and disk                                                                                                                                                                                                                                                                             | snapshot-produced patches are capped at 10 MiB per patch and 10 MiB aggregate (`packages/opencode/src/snapshot/index.ts:25-26`); generated-path denylist; new summaries store metadata and recompute on read                              |
| Run-UI subagent tab eviction | The run-mode subagent list keeps the newest 50 finished agents, not every one ever spawned                                                                                                                                                                                                                                         | running, pinned, and permission-holding sessions exempt; evicted agents revive if they ask again; synthetic-gated background settlement  |
| TUI payload eviction         | Sessions you navigate away from drop their message/part payloads from memory (keep-last-~20 viewed); they rehydrate on return                                                                                                                                                                                                      | guards for active/running/permission/in-flight sessions; failed revival re-arms; plugin getters auto-refetch                             |
| Child conveyor (daily TUI)   | Child sessions join the conveyor at their _first_ received message (the delegation) and never re-rank afterwards — task continuations, compaction replays, plan-tool self-injections, tool rounds, and permissions never shuffle the list or the footer while agents work                                                                                                                                                        | client-side rank map (first 256 distinct children ranked once, never evicted, roots excluded); newest-50 window; viewed out-of-window child pins in; footer shows an honest N of 50 |
| TUI delta coalescing         | The UI-side twin of #42150: streamed chunks coalesce and apply every 120 ms instead of quadratic per-chunk store writes — for every session in the process, background subagents included                                                                                                                                          | `packages/tui/src/context/part-delta-buffer.ts`; authoritative part/message updates drop pending buffers                                 |
| Deleted-session cleanup      | Deleting a session actually drops its message/part/diff/status/permission/question buckets from the UI store, tombstones the session so late events can't resurrect it, and a removed message drops its part bucket immediately (upstream [#12351](https://github.com/anomalyco/opencode/issues/12351), reported by **Limme-swe**) | `session.deleted`/`message.removed` handlers + tombstone gate in `packages/tui/src/context/sync.tsx`                                     |
| Git subcommand classifier    | "Always allow" for `git -C ../worktree commit` stores `git commit *` — never junk, never a wider grant than you approved                                                                                                                                                                                                           | env/command unwrapping + git global-option skipping + scoped patterns                                                                    |
| Payload byte+count budget    | TUI payload memory has a hard ceiling: when non-active session payloads exceed it, the least-recently-viewed ones drop (no auto-refetch); routing back rehydrates them. Streaming children keep working — their payloads drop only when non-active, and their status/permission events still flow. Permission prompts for evicted parts survive via a `toolInput` field carried on the permission event itself, so a prompt never needs its part payload resident | `packages/tui/src/context/payload-budget.ts`; see the bound-knob inventory below. |
| Durable event paging         | Durable aggregate replay reads two-phase byte+row bounded pages instead of materializing an unbounded tail                                                                                                                                                                                                                          | `packages/core/src/event.ts`; fixed page limits are 100 decoded rows and 8 MiB serialized UTF-8 bytes; no environment knobs. |
| Background-job terminal ring | Settled background jobs retain a bounded terminal ring; oldest entries evict and output is stripped under byte pressure while active jobs remain protected                                                                                                                                                                                                                                      | `packages/core/src/background-job.ts`; see the bound-knob inventory below. |
| Offline database vacuum guard | `opencode db vacuum` requires an exclusive lock and, on Linux, refuses when `/proc` finds another process holding the database or sidecars; the lock stays held across the guard commit and `VACUUM`                                                                                                                                                                                           | Fork-custom safety procedure around the partial #43456 command; `opencode db stats` uses a detached snapshot that excludes live WAL contents and reports `wal_bytes` separately. |
| LSP document LRU             | Open LSP documents (full text kept for incremental sync) are evicted least-recently-used with an explicit `didClose` — bounded by both count and bytes, refresh reads one file at a time, and diagnostics for closed docs are discarded via generation tokens                                                                                                                                                                                              | `packages/opencode/src/lsp/document-store.ts`; see the bound-knob inventory below. |

### Resource-bound knob inventory

All knobs below use the source parser for their unit: byte limits require a `KB` or `MB` suffix and count limits are plain integers. The exact string `"0"` disables that individual bound. Durable event page limits are fixed constants, not environment knobs.

| Area | Knob | Default | Bound |
| ---- | ---- | ------- | ----- |
| TUI payload | `OPENCODE_TUI_PAYLOAD_BUDGET_MB` | `256MB` | Total non-active payload bytes |
| TUI payload | `OPENCODE_TUI_PAYLOAD_SESSION_LIMIT` | `20` | Retained non-active sessions |
| TUI payload | `OPENCODE_TUI_ACTIVE_ALLOWANCE_MB` | `128MB` | Active-session payload allowance |
| TUI payload | `OPENCODE_TUI_ACTIVE_PART_MAX_MB` | `32MB` | Per-part scalar-leaf cap for active sessions (see below) |
| TUI payload | `OPENCODE_TUI_PART_INGRESS_MAX_KB` | `256KB` | Per-part ingress bytes |
| TUI delta buffer | `OPENCODE_TUI_DELTA_BUFFER_MAX_KB` | `4096KB` | Pending delta bytes |
| TUI delta buffer | `OPENCODE_TUI_DELTA_BUFFER_MAX_ENTRIES` | `512` | Pending delta entries |
| TUI mirror | `OPENCODE_TUI_MIRROR_BUDGET_MB` | `64MB` | Mirrored message bytes |
| TUI mirror | `OPENCODE_TUI_MIRROR_MSG_MAX_KB` | `512KB` | Per-message mirrored bytes |
| TUI mirror | `OPENCODE_TUI_MIRROR_SESSION_LIMIT` | `20` | Mirrored sessions |
| TUI permissions | `OPENCODE_TUI_PERMISSION_ALLOWANCE_MB` | `32MB` | Stored permission-input byte bound (2x allowance) |
| TUI permissions | `OPENCODE_TUI_PERMISSION_INPUT_MAX_ENTRIES` | `512` | Stored permission-input entry count bound |
| LSP documents | `OPENCODE_LSP_DOC_LIMIT` | `128` | Resident full-text documents |
| LSP documents | `OPENCODE_LSP_DOC_MAX_MB` | `64MB` | Resident full-text bytes |
| LSP documents | `OPENCODE_LSP_DOC_OPEN_ALLOWANCE_MB` | `32MB` | Single-document open allowance |
| LSP documents | `OPENCODE_LSP_OVERSIZED_LIMIT` | `8` | Metadata-only oversized-document records |
| LSP diagnostics | `OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT` | `256` | Retained pull-diagnostic files (never-opened) |
| LSP diagnostics | `OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB` | `8MB` | Retained pull-diagnostic bytes (never-opened) |
| Background jobs | `OPENCODE_BGJOB_SETTLED_MAX` | `100` | Settled terminal entries |
| Background jobs | `OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB` | `8MB` | Settled terminal output bytes |
| Durable events | fixed `DURABLE_PAGE_ROWS` / `DURABLE_PAGE_BYTES` | `100` / `8 MiB` | Row and serialized-byte page caps; no env knobs |

Part-cap scope (honest bounds): `OPENCODE_TUI_ACTIVE_PART_MAX_MB` truncates
selected scalar leaves only — part text/reasoning/completed-tool output, and
permission inputs. It is not a whole-part envelope: `ToolPart.state.input`,
`state.metadata`, error strings, `SnapshotPart.snapshot`, `SubtaskPart.prompt`,
and `AssistantMessage.structured` pass through untruncated, and the active
session's message count, todos, and session diffs remain unbounded. A
pathological active session therefore has no finite worst-case RSS under this
design; the bound removes the streaming-text and tool-output accumulators that
dominated real-world growth.

## Deliberately NOT ported

| Upstream PR                             | Reason                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| #42771 (event payload → side table)     | only remaining schema change; revisit if event-table disk growth becomes acute      |
| #43455 (snapshot retry/circuit breaker) | robustness not memory; conflicts with diff-cap customs' surface                     |
| #22428 (PRAGMA mmap_size=0)             | no-op on Linux; macOS-targeted                                                      |
| #16695 (memory-leak consolidation)      | closed unmerged by stalebot; useful pieces (LSP LRU) belong in fork customs instead |
| #33713 (idle instance eviction)         | dormant upstream, wrong shape for multi-process usage                               |

## Install details and rollback

> **Made for the terminal.** This fork targets `opencode` in the terminal (the
> TUI) — the daily driver it was built from, and where every memory bound is
> tested. Everything else (web UI, `opencode serve`, desktop/IDE clients) keeps
> working and inherits the server-side fixes too, but the UI-side memory wins
> are terminal-only.

### One command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/renekris/opencode-lowmem/lowmem/scripts/fork-install.sh | bash
```

The script detects your OS and CPU (Linux/macOS/Windows, including
musl-vs-glibc on Linux), downloads the matching binary from the latest GitHub
release, verifies its SHA-256 against the release digest, and installs it to
`~/.opencode/bin/opencode`.

Then run `opencode` as usual:

1. Open sessions are never killed — they keep their old build.
2. Every **new** session runs the lowmem build.
3. Auth, config, sessions, and plugins carry over unchanged — same
   `opencode.db`, same settings, nothing to migrate.

Going back to stock opencode later is just reinstalling the upstream binary the
way you originally installed it; the shared database needs no changes.

### Build from source

Requires [bun](https://bun.sh):

```bash
git clone https://github.com/renekris/opencode-lowmem
cd opencode-lowmem
./scripts/fork-build.sh
```

Builds all platform targets, stamps the version (`<upstream>-lowmem.<round>`
from git tags — round = highest existing + 1), smoke-tests, and tags the build.

### Sandbox proof

Before declaring a build or zero-migration round complete, run the isolated
summary-diff proof from the repository root:

```bash
BIN=packages/opencode/dist/opencode-linux-x64/bin/opencode \
SOURCE_XDG_DATA_HOME="$HOME/.local/share" \
bun scripts/ram-bounds/summary-diff-proof.ts
```

The script validates `SOURCE_XDG_DATA_HOME` and an optional
`SANDBOX_XDG_DATA_HOME` before use: configured roots cannot contain `..`, be
symlinks, or overlap after both roots are canonicalized with `realpath()`. A
configured sandbox is only created under its nearest existing ancestor after
that ancestor is verified component-by-component to be free of symlinks, so a
symlinked ancestor cannot redirect creation into the live data root. It
opens the source database through `sqlite3 --readonly` and uses the CLI
`.backup` command to make a WAL-safe copy inside the sandbox. The destination
path is rejected if it contains a single quote or control character, rather
than relying on dot-command quoting. The binary never receives the source
root: it receives an environment allowlist containing `PATH`, sandbox `HOME`,
the four sandbox XDG directories, `LANG`, and `TZ`.

After the backup, every session directory in the sandbox database is remapped
to the sandbox scratch directory. The script runs `session list`, then reads
only the sandbox database. A metadata-only candidate gets the always-runnable
HTTP diff assertion, which requires HTTP 200 and the stored file/count/status
metadata. A retained-snapshot candidate must have both snapshot hashes in its
`step-start`/`step-finish` parts and matching storage under
`opencode/snapshot/<project-id>/<sha1(worktree)>` and a copyable standalone Git
worktree (worktrees whose `.git` uses object alternates are disqualified
because the alternates point at a live object store). The script ranks
qualifying worktrees with `du` and skips the retained branch with that measured
reason when the smallest exceeds the 300 MiB bound, and each attempt starts
from a clean scratch directory so a failed candidate cannot leak into the next
one. The copies themselves are transfer-bounded with a chunked copy that never
writes more than the remaining byte allowance, so even a concurrently growing
source cannot push peak sandbox disk usage past the bound — and the snapshot
Git storage is made self-contained in the sandbox: the full object closure
reachable from the two snapshot hashes is enumerated with `rev-list --objects`
streamed to a file whose capture is capped at the remaining candidate bound
(never buffered in this process), materialized locally by piping
`pack-objects --stdout` into the same capped writer — git is killed the moment
the pack crosses the remaining allowance, so a pathological pack can never
land in full — indexed with `index-pack`, and the closure list plus
pack+index(+rev) bytes are post-checked against the remaining bound before the
borrowed alternates link into the live repository is removed. The index pair
is the one artifact that can transiently overshoot before that post-check
(its size is proportional to the packed object count, not content size); a
failing check removes the whole candidate. The
closure walk is repeated alternates-free so a missing blob anywhere in the
reachability set fails before any `git` command serves the proof. Candidates
are tried smallest-first until one satisfies the branch; only after every
qualifying candidate fails does the retained check report `SKIP` with the
aggregated per-candidate reasons. Otherwise it starts one sandbox-owned
`serve` process, and requires the retained HTTP diff response to contain a real
non-omitted patch string. Both checks use the remapped sandbox directory.

Missing source, missing `sqlite3`, invalid configured roots, a non-empty
configured sandbox, an unsafe backup destination, or a missing `BIN` are
friendly failures. Missing metadata or retained candidates are explicit
`SKIP` results, never fabricated fixtures. Shutdown sends `SIGTERM`, waits at
most two seconds, then sends `SIGKILL` and waits up to another two seconds under
a hard deadline. Set `SANDBOX_XDG_DATA_HOME` to an empty isolated directory to keep
the sandbox for inspection; otherwise the generated temporary directory is
removed during cleanup.

## Maintaining the fork

Rebase onto the new upstream tag. Behavior-pinning tests fail loudly if an
upstream refactor moved a hunk — re-check the seam, never delete the test.
Full upkeep procedure and rollback recipe: fork section of [AGENTS.md](AGENTS.md).

**Rebase seams** (where fork hunks live inside upstream files; everything else
is fork-owned files):

- `packages/opencode/src/session/processor.ts` — #43881 empty-stream guard +
  #42176 `finish = "error"` (guarded by `test/session/processor-effect.test.ts`)
- `packages/opencode/src/provider/provider.ts` — #43607 `wrapSSE` single
  deadline (guarded by `test/provider/header-timeout.test.ts`)
- `packages/opencode/src/session/session.ts` — one-line shallow-copy in
  `updatePart` (#35107), plus the `Session.fork()` legacy-summary trim that
  strips full patches from cloned summaries before re-publishing them as new
  durable events
- `packages/opencode/src/session/summary.ts` — one-line write seam applying
  metadata-only trimming before the durable message update
- `packages/opencode/src/session/summary-diff-trim.ts` — fork-owned helper that
  strips patch text from new summary entries; keep it separate for rebases
- `packages/opencode/src/cli/cmd/run/subagent-data.ts` + `stream.transport.ts` —
  run-UI eviction (settle/revive/compact helpers; small transport delta)
- `packages/tui/src/context/sync.tsx` — marked `Fork(lowmem)` hunks: delta-buffer
  wiring + flushed-part tracking, inbound-rank hook + root purge,
  `session.deleted` cleanup, eviction-gate breaks, budget accounting hooks
  (append/replace/remove/part-upsert/bulk-hydration), permission-asked
  `toolInput` capture (guarded by `test/payload-budget.test.ts`,
  `test/no-revival.test.ts`, `test/cli/cmd/tui/sync-payload-eviction.test.tsx`)
- `packages/tui/src/routes/session/index.tsx`, `subagent-footer.tsx` —
  conveyor call-site injections only

**RAM-bounds seams** (rounds 1–2, same rules — re-check each on rebase):

- `packages/core/src/event.ts` — codec WeakMap cache + two-phase byte-aware
  `readAfter` paging (`test/durable-paging.test.ts`, `test/event.test.ts`)
- `packages/core/src/background-job.ts` — terminal ring + settled contract +
  late-caller `waitForPromotion` (`test/background-job-settled.test.ts`)
- `packages/opencode/src/cli/cmd/db.ts` — stats partial port + wiring; fork
  vacuum guard lives in fork-owned `db-vacuum.ts` (`test/db-cmd.test.ts`)
- `packages/opencode/src/lsp/client.ts` — lifecycle coordination: bounded
  close-tombstones, per-open generation tokens, oversized transient close,
  deferred single-flight loader (`test/lsp-reopen.test.ts`,
  `test/document-store.test.ts`)
- `packages/opencode/src/permission/index.ts` + `session/tools.ts` — preserve
  and populate `toolInput` on `permission.asked` (same tests as schema row)
- `packages/schema/src/v1/permission.ts` — optional typed `toolInput` field
  (contract test in `packages/sdk/js`; schema manifest count intentionally
  shifts — pre-existing failures documented in the round-1 evidence)
- `packages/tui/src/context/data.tsx` — mirror-budget wiring; implementation
  is fork-owned `context/mirror-budget.ts` (`test/mirror-budget.test.tsx`)
- `packages/tui/src/plugin/adapters.tsx` — `requestRevival` call-sites removed
  (no-revival rule; `test/no-revival.test.ts`)
- `packages/tui/src/routes/session/permission.tsx` — reads `toolInput` from the
  permission map (store copy is stripped; same payload-budget tests)
- `packages/sdk/js/src/v2/gen/*` — REGENERATED via `bun run generate`
  (packages/client) for the `toolInput` surface; never hand-edited

**Watch-list** (adopt upstream if merged, replacing our port): #39970
(comprehensive stream-incomplete handling, supersedes #43881/#43607), #41466
(same empty-stream bug via new error type), #40142 (finish=length loop exit),
#43302 (v2 sync engine — design-borrow only). Candidates adopted from the
latest update sweep: #39930 (bound compacted history hydration),
#38939 (PubSub `allBounded` listener leak), #41950 (config global-cache clone),
#33713 (evict idle per-directory serve instances), #44631 (Bedrock 16 MiB
event-stream frame reject).

**Deferred ports**: #43769 (parallel-session snapshot scan CPU −77%; blocked —
authored against the post-split `packages/ai`/`packages/util` tree that does
not exist in our base yet) and #40698 (TUI
syntax-highlight LRU cache; wraps `getTreeSitterClient().highlightOnce`).
Correction 2026-08-25: `highlightOnce` IS present in our pinned
`@opentui/core` (`lib/tree-sitter/client.d.ts`) — the earlier absence claim
was wrong. #40698 stays deferred for scope/priority (own behavior-preserving
round), not for a missing seam; #43769 stays blocked until the base carries
the post-split tree. Porting #43769 now would mean inventing seams upstream
will replace. Already-merged perf PRs riding the next tag: #42826, #43292,
#42346, #42579, #42741, #42952, #43191, #43158, #42467, #42458, #42468,
#42972.

**Backlog** (unclaimed, no upstream equivalent): run-UI delta coalescing
(`packages/opencode/src/cli/cmd/run/session-data.ts`
still concatenates and flushes per delta — changing it means changing footer
render cadence, so it needs its own behavior-preserving round); serve-mode SSE
event queue is unbounded (`handlers/event.ts`) — backpressure policy needed;
log rotation cap; `tool-output/` retention policy; `PRAGMA auto_vacuum`.

## Credit

All ported work is credited in the tables above and in each commit's
`(port of upstream #NNNNN)` trailer. Upstream authors did the hard diagnosis;
this fork just ships it.

## About upstream

This fork builds on [opencode](https://github.com/anomalyco/opencode) — the open
source AI coding agent, pinned to the latest merged upstream release tag (see
this repo's tags and releases for the current base). See the
[upstream README](https://github.com/anomalyco/opencode/tree/dev#readme) for
everything not fork-specific.
