# Fork Port Manifest — `port/ram-fixes`

This fork is a resource-bounded build of [anomalyco/opencode](https://github.com/anomalyco/opencode):
full capability, bounded footprint. It carries local patches plus ports of upstream
community PRs that were never merged. **All ported work is credited here and must stay
credited** — if a port later becomes redundant (upstream merges it), mark it `ADOPTED
UPSTREAM at vX.Y.Z` below rather than deleting the row.

Base: `v1.18.21` (`826d9ad46a`). Fork lineage: `local-diff-caps` → `port/ram-fixes`.
Public branch: `lowmem` at [renekris/opencode-lowmem](https://github.com/renekris/opencode-lowmem).

## Installing / building

```bash
./scripts/fork-build.sh
```

Derives and stamps the version (`<upstream-base>-lowmem.<round>`, round = highest
existing round tag + 1), builds all platform targets, smoke-tests `--version`, tags the
build, and ensures the `~/.opencode/bin/opencode` shim execs this checkout's dist binary
(writes the shim only when missing). Running sessions are never killed — new sessions
pick up the new build automatically. `OPENCODE_CHANNEL=latest` is baked in and
mandatory: any other channel makes the binary open `opencode-<channel>.db` instead of
the shared `opencode.db`.

## Finding fork commits (docs are SHA-free by policy)

Commit hashes are deliberately **not** listed anywhere in this manifest — history
consolidations rewrite them, and stale SHAs are worse than none. Instead:

```bash
git log --grep '(port of upstream #42150)'          # a specific port
git log --oneline v1.18.21..HEAD -- <file-path>     # everything touching a seam
```

## Ported upstream PRs

| Upstream PR | Author | Title | Notes |
|---|---|---|---|
| [#39930](https://github.com/anomalyco/opencode/pull/39930) | **brauliobo** | fix(session): bound compacted history hydration | 609-msg session: 11 MB → 0.8 MB materialized |
| [#42150](https://github.com/anomalyco/opencode/pull/42150) | **hardes11** | fix(opencode): O(N) text/reasoning delta accumulation | processor-side; the TUI-side twin is a local custom (below) |
| [#38939](https://github.com/anomalyco/opencode/pull/38939) | **Shalin-Shah-2002** | fix(core): prevent allBounded listener leak | local deviation: listeners restored to Array semantics (duplicates must deliver independently) |
| [#41950](https://github.com/anomalyco/opencode/pull/41950) | **weiconghe** | fix(config): clone global cache to prevent cross-workspace mutation leak | |
| [#43881](https://github.com/anomalyco/opencode/pull/43881) | **moritzscheele** | fix(opencode): fail empty provider streams so retries engage | 3.5h live-verified by the author; we add a clean-EOF regression test and an observed-output guard (never retry a stream that already emitted text) |
| [#42176](https://github.com/anomalyco/opencode/pull/42176) | **vladislav-miroshnikov** | fix(opencode): mark finish reason error on stream failures | |
| [#43607](https://github.com/anomalyco/opencode/pull/43607) | **1052326311** | fix(opencode): SSE heartbeat comments no longer reset the chunk timeout | we add a multi-byte-split regression test |

Each port commit message carries `(port of upstream #NNNNN)`; do not drop that trailer.

## Local customs (authored in this fork)

Listed by feature with primary files and bounds. Detail and design rationale in the
sections below.

| Feature | Primary files | Bounds |
|---|---|---|
| Stored diff-patch caps | `packages/opencode/src/session/snapshot/index.ts`, `summary.ts` | per-patch 100 KB, generated-path denylist, 4k-line rule, 256 KB aggregate per snapshot op; summaries store metadata and recompute on read |
| Git subcommand classifier | permission classification | env/`-C`/`-c` wrapper-aware; scopes "always allow" patterns to the real subcommand. Not memory-related — kept because this fork is the daily driver and upstream still lacks it; good candidate to contribute upstream |
| Run-UI subagent tab eviction | `packages/opencode/src/cli/cmd/run/subagent-data.ts`, `stream.transport.ts` | 50 completed tabs/details; running, pinned, and blocker-holding sessions exempt; synthetic-gated background settlement; 256-entry eviction-revival memory |
| TUI payload eviction | `packages/tui/src/context/payload-eviction.ts`, `sync.tsx` | sessions viewed out drop their message/part buckets (keep-last-~20 viewed); guards for active/running/permission/in-flight; failed revival re-arms the gate; plugin getters auto-refetch |
| Child conveyor (daily TUI) | `packages/tui/src/routes/session/child-sessions.ts`, `child-inbound.ts` | reorders only on inbound user messages; newest-50 window with viewed-child pin-in |
| Long-session RAM trio | `packages/tui/src/context/part-delta-buffer.ts`, `sync.tsx`, `packages/opencode/src/session/session.ts` | TUI delta coalescing (120 ms), shallow-copy PartUpdated publish, full cleanup on `session.deleted` |
| Release tooling | `scripts/fork-build.sh`, `scripts/fork-install.sh` | round derivation from max tag; installer fails closed without a digest |

## Feature semantics & design decisions

### Long-session RAM (2026-08-24)

- **TUI delta coalescing** (`packages/tui/src/context/part-delta-buffer.ts`, sync.tsx wiring):
  the TUI-side twin of upstream #42150 (hardes11 — also the basis of our server-side port) —
  `message.part.delta` appends ran O(n²) string churn inside the Solid store for every hosted
  session (background subagents included). Deltas now coalesce per message/part/field and apply
  every 120ms; `part.updated`/`message.updated` drop pending buffers (authoritative state wins).
- **updatePart shallow copy** (`packages/opencode/src/session/session.ts`): replaces
  `structuredClone(part)` on every PartUpdated publish — issue reported by xingruodong-sys
  (#35107), fix shape from ColeLindfors' closed-unmerged #43733. Verified safe: no consumer
  mutates nested part fields in place; TUI stores via `reconcile()`.
- **session.deleted bucket cleanup** (`packages/tui/src/context/sync.tsx`): deleted sessions
  leaked message/part/session_diff/session_status buckets — issue reported by Limme-swe
  (#12351).

### Child-conveyor ordering (daily TUI)

Child sessions reorder only when they RECEIVE a user message (delegation, task_id
continuation, direct input). Signal is client-side: `packages/tui/src/routes/session/child-inbound.ts`
ranks `message.updated` events with `role === "user"` (bounded 256-entry map, consumed before
the payload-eviction gate; known-root sessions are skipped and provisional ranks purge when a
row proves parentless; `session.deleted` cleans up; creation-time fallback after restart). The
conveyor shows at most the newest 50 children (CHILD_CONVEYOR_LIMIT); a viewed child outside
the window is pinned in by displacing the window's oldest member. The run-mode tab list
intentionally keeps its own lifecycle/activity ordering (status-centric menu), diverging from
the daily TUI's inbound-receipt conveyor.
Known deviations: plan-tool self-injections and compaction auto-continue replays also write user
messages and move the child. Exact alternative rejected: a `session.message.received` server
event (Oracle design) — requires an event-contract change; revisit only if the deviations matter.

## Rebase seams (review guidance)

The fork delta is deliberately concentrated; when rebasing, check these seams first.
Anything growing beyond the described delta is a mistake.

**Server-side (packages/opencode):**

- `src/session/processor.ts` — two disjoint hunks: #43881's empty-stream guard after the
  drain block (fires on `finish === "unknown"` with zero output tokens AND no observed
  stream output, when compaction is not pending), #42176's `finish = "error"` in the
  generic error path. Guarded by `test/session/processor-effect.test.ts`.
- `src/provider/provider.ts` — #43607's `wrapSSE`: one chunk-timeout deadline per stream,
  reset only on complete SSE `data:` events. Guarded by `test/provider/header-timeout.test.ts`.
- `src/session/session.ts` — one-line shallow-copy in `updatePart` (#35107). If upstream
  reintroduces `structuredClone(part)` here, that's our hunk regressing.
- `src/cli/cmd/run/subagent-data.ts` — nearly all run-UI fork logic (compact/settle/revive
  helpers, `knownSubagentSession`; list ordering is upstream's). Upstream churn inside
  `taskTab`, `syncTaskTab`, `reduceSubagentData`, or `bootstrapSubagentData` needs the fork
  hunks re-checked, not re-derived.
- `src/cli/cmd/run/stream.transport.ts` — small delta: import +
  `tracked()`/`trackBlocker` delegate to `knownSubagentSession`, plus `pinnedSessionID`
  threading at the two reduce call sites.
- Terminal signal we parse: synthetic (`part.synthetic === true`) parent text part shaped
  `<task id="ses_*" state="completed|error">` from `TaskTool.injectBackgroundResult`
  (task.ts). Child terminal messages are deliberately NOT a settle signal:
  `background.extend` keeps a job running after a child prompt completes (task.test.ts).

**TUI-side (packages/tui):**

- `src/context/sync.tsx` — four marked `Fork(lowmem)` hunks: delta-buffer wiring
  (`message.part.delta`/`part.updated`/`message.updated`), inbound-rank hook + root purge
  (`message.updated`/`session.updated`), `session.deleted` bucket cleanup, and the
  eviction-gate `break`s. The eviction logic itself lives in `payload-eviction.ts` (fork-owned).
- `src/context/part-delta-buffer.ts`, `src/routes/session/child-inbound.ts`,
  `src/routes/session/child-sessions.ts` — fork-owned files; upstream does not have them.
- `src/routes/session/index.tsx` — call-site injections only (`newestChildSessionID`/
  `cycleChildSessionID` rank arg); the `children()` memo stays upstream-lexical
  (permissions()/questions() aggregation depends on it).
- `src/routes/session/subagent-footer.tsx` — N-of-M renders via `childSessionWindow`.

## Durability policy (rebase rules)

Every fork change must survive upstream churn without silent semantic loss:

1. Ports and customs live in isolated commits with `(port of upstream #NNNNN)`
   trailers — never mixed with unrelated changes, so a conflicting rebase points
   at exactly one decision.
2. Behavior is pinned by tests shipped in (or alongside) the same commit. A test
   failing after an upstream rebase means the seam moved; re-check the hunk, do
   not delete the test.
3. Fork delta concentrates in fork-owned files where possible; seams in
   high-churn upstream files are listed above and must stay minimal.
4. Docs reference files and upstream PRs, never commit SHAs (rewritten by
   consolidations; use `git log --grep` instead).
5. Watch-list (adopt if upstream merges, replacing our port): #39970
   (comprehensive stream-incomplete handling, supersedes #43881/#43607), #41466
   (same empty-stream bug via new error type), #40142 (finish=length loop exit),
   #43302 (v2 sync engine — design-borrow only).

## Evaluated, deliberately NOT ported

| Upstream PR | Reason |
|---|---|
| #40861 (summary diffs metadata-only) | superseded by the diff-cap customs (same design, recompute fallback) |
| #42771 (event payload → side table) | gated: only remaining schema change; revisit if event-table disk growth becomes acute |
| #43455 (snapshot retry/circuit breaker) | robustness not memory; conflicts with diff-cap customs' surface |
| #22428 (PRAGMA mmap_size=0) | no-op on Linux (defaults to 0); macOS-targeted |
| #16695 (memory-leak consolidation) | closed unmerged by stalebot; useful pieces (LSP LRU) belong in fork customs instead |
| #33713 (idle instance eviction) | dormant upstream, wrong shape for multi-process usage |

## Fork charter — "lite without being lite"

Every patch must **bound a resource without removing a capability**. Fixes that degrade
function are out. Backlog (unclaimed, no upstream equivalent):

1. LSP files LRU (~100 files) — `packages/opencode/src/lsp/client.ts` store is set-never-deleted
2. BackgroundJob settled-entry eviction — `packages/core/src/background-job.ts` Map never deletes
3. Per-session Effect EventTarget listener leak (upstream #29204, no fix PR)
4. Log rotation cap — `data/log/` grows unbounded
5. `tool-output/` retention window — needs a policy decision (old tool results stop rendering)
6. `PRAGMA auto_vacuum=INCREMENTAL` — see upstream #31526

See the fork section of `AGENTS.md` for the upkeep procedure and rollback recipe.
