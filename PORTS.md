# Fork Port Manifest — `port/ram-fixes`

This fork is a resource-bounded build of [anomalyco/opencode](https://github.com/anomalyco/opencode):
full capability, bounded footprint. It carries local patches plus ports of upstream
community PRs that were never merged. **All ported work is credited here and must stay
credited** — if a port later becomes redundant (upstream merges it), mark it `ADOPTED
UPSTREAM at vX.Y.Z` below rather than deleting the row.

Base: `v1.18.21` (`826d9ad46a`). Fork lineage: `local-diff-caps` → `port/ram-fixes`.

## Installing / building

```bash
./scripts/fork-build.sh
```

Derives and stamps the version (`<upstream-base>-lowmem.<round>`, round tracked as git
tags), builds all platform targets, smoke-tests `--version`, tags the build, and ensures
the `~/.opencode/bin/opencode` shim execs this checkout's dist binary (writes the shim
only when missing). Running sessions are never killed — new sessions pick up the new
build automatically. `OPENCODE_CHANNEL=latest` is baked in and mandatory: any other
channel makes the binary open `opencode-<channel>.db` instead of the shared `opencode.db`.

## Ported upstream PRs

| Upstream PR | Author | Title | Our commit | Status |
|---|---|---|---|---|
| [#39930](https://github.com/anomalyco/opencode/pull/39930) | **brauliobo** | fix(session): bound compacted history hydration | `a95c3c9175` | ported 2026-08-22 |
| [#42150](https://github.com/anomalyco/opencode/pull/42150) | **hardes11** | fix(opencode): O(N) text/reasoning delta accumulation | `73cedfe502` | ported 2026-08-22 |
| [#38939](https://github.com/anomalyco/opencode/pull/38939) | **Shalin-Shah-2002** | fix(core): prevent allBounded listener leak via PubSub subscription | `74df05e463` | ported 2026-08-22 |
| [#41950](https://github.com/anomalyco/opencode/pull/41950) | **weiconghe** | fix(config): clone global cache to prevent cross-workspace mutation leak | `79f27203e1` | ported 2026-08-22 |
| [#43881](https://github.com/anomalyco/opencode/pull/43881) | **moritzscheele** | fix(opencode): fail empty provider streams so retries engage (3.5h live-verified against a flaky gateway) | `171402da4f` | ported 2026-08-22, adds a clean-EOF regression test |
| [#42176](https://github.com/anomalyco/opencode/pull/42176) | **vladislav-miroshnikov** | fix(opencode): mark finish reason error on stream failures | `7d853dfe84` | ported 2026-08-22 |
| [#43607](https://github.com/anomalyco/opencode/pull/43607) | **1052326311** | fix(opencode): SSE heartbeat comments no longer reset the chunk timeout | `5787497d8a` | ported 2026-08-22 |

Each port commit message carries `(port of upstream #NNNNN)`; do not drop that trailer.

## Local customs (authored in this fork)

| Commit | Title | Bounds |
|---|---|---|
| `d96a51646e` | fix(opencode): cap stored snapshot diff patches | per-patch 100KB, generated-path denylist, 4k-line rule |
| `b89cf97a35` | fix(opencode): cap aggregate stored diff patches | 256KB cumulative per snapshot op |
| `dd77d3619d` | fix(opencode): avoid storing summary diff patches | summary diffs store metadata; recompute on read |
| `7d6933befb` | fix(permission): classify git subcommands | env/-C/-c wrapper-aware git subcommand classification; scopes git permission patterns to the real subcommand. Not memory-related — kept because this fork is the daily driver and upstream still lacks it (verified at v1.18.21); good candidate to contribute upstream |
| `8746b60407` | feat(opencode): bound subagent tabs with keep-last-N eviction | 50 completed tabs/details; running, pinned, and blocker-holding sessions exempt |
| `0ad600c39a` (refined `86fe0d6536`, tests `98e7dd83a7`) | fix(opencode): background-safe settlement + eviction revival | Background parts stay "running" until the synthetic injection settles them (synthetic-gated; user text cannot spoof). Evicted sessions revive on queued permission/question (256-entry memory). Reply events re-compact to release guard slots. Deterministic tie-breaks |

### Child-conveyor ordering (daily TUI)

Child sessions reorder only when they RECEIVE a user message (delegation, task_id
continuation, direct input). Signal is client-side: `packages/tui/src/routes/session/child-inbound.ts`
ranks `message.updated` events with `role === "user"` (bounded 256-entry map, consumed before
the payload-eviction gate; `session.deleted` cleans up; creation-time fallback after restart).
Known deviations: plan-tool self-injections and compaction auto-continue replays also write user
messages and move the child. Exact alternative rejected: a `session.message.received` server
event (Oracle design) — requires an event-contract change; revisit only if the deviations matter.

### Subagent-eviction upstream coupling (review guidance)

The fork delta is deliberately concentrated; when rebasing, check these seams first:

- `packages/opencode/src/cli/cmd/run/subagent-data.ts` — nearly all fork logic lives here
  (compact/settle/revive helpers, `knownSubagentSession`; list ordering is upstream's).
  Upstream
  churn inside `taskTab`, `syncTaskTab`, `reduceSubagentData`, or `bootstrapSubagentData`
  needs the fork hunks re-checked, not re-derived.
- `packages/opencode/src/cli/cmd/run/stream.transport.ts` — 8-line delta: import +
  `tracked()`/`trackBlocker` delegate to `knownSubagentSession`, plus `pinnedSessionID`
  threading at the two reduce call sites. Anything else changing here is NOT ours.
- Terminal signal we parse: synthetic (`part.synthetic === true`) parent text part
  shaped `<task id="ses_*" state="completed|error">` from `TaskTool.injectBackgroundResult`
  (task.ts). Child terminal messages are deliberately NOT a settle signal:
  `background.extend` keeps a job running after a child prompt completes
  (task.test.ts), so a child `message.updated` cannot prove job termination.

### Reliability-port upstream coupling

- `packages/opencode/src/session/processor.ts` — two disjoint hunks: (1) #43881's
  empty-stream guard after the drain block (fires on `finish === "unknown"` with
  zero output tokens when compaction is not pending), (2) #42176's
  `ctx.assistantMessage.finish = "error"` in the generic error path. Guarded by
  tests in `test/session/processor-effect.test.ts` ("retries a clean EOF",
  finish-on-error assertion) — if upstream refactors the drain/error paths, those
  tests fail loudly instead of the fix regressing silently.
- `packages/opencode/src/provider/provider.ts` — #43607's `wrapSSE` keeps ONE
  chunk-timeout deadline per stream and resets it only when a complete SSE
  `data:` event is observed (comment heartbeats don't count). Guarded by
  `test/provider/header-timeout.test.ts` ("ignores SSE comment heartbeats").

### Durability policy (rebase rules)

Every fork change must survive upstream churn without silent semantic loss:

1. Ports and customs live in isolated commits with `(port of upstream #NNNNN)`
   trailers — never mixed with unrelated changes, so a conflicting rebase points
   at exactly one decision.
2. Behavior is pinned by tests shipped in (or alongside) the same commit. A test
   failing after an upstream rebase means the seam moved; re-check the hunk, do
   not delete the test.
3. Fork delta concentrates in fork-owned files where possible
   (`subagent-data.ts`); seams in high-churn upstream files
   (`processor.ts`, `provider.ts`, `stream.transport.ts`) are listed above and
   must stay minimal — anything growing beyond the described delta is a mistake.
4. Watch-list (adopt if upstream merges, replacing our port): #39970
   (comprehensive stream-incomplete handling, supersedes #43881/#43607), #41466
   (same empty-stream bug via new error type), #40142 (finish=length loop exit).

## Evaluated, deliberately NOT ported

| Upstream PR | Reason |
|---|---|
| #40861 (summary diffs metadata-only) | superseded by local custom `dd77d3619d` (same design, recompute fallback) |
| #42771 (event payload → side table) | gated: only remaining schema change; revisit if event-table disk growth becomes acute |
| #43455 (snapshot retry/circuit breaker) | robustness not memory; conflicts with diff-cap customs' surface (`snapshot/index.ts`) |
| #22428 (PRAGMA mmap_size=0) | no-op on Linux (defaults to 0); macOS-targeted |
| #16695 (memory-leak consolidation) | closed unmerged by stalebot; useful pieces (LSP LRU) belong in fork customs instead |
| #33713 (idle instance eviction) | dormant upstream, wrong shape for multi-process usage |

## Fork charter — "lite without being lite"

Every patch must **bound a resource without removing a capability**. Fixes that degrade
function are out. Backlog (unclaimed, no upstream equivalent):

1. LSP files LRU (~100 files) — `packages/opencode/src/lsp/client.ts` store is set-never-deleted
2. BackgroundJob settled-entry eviction — `packages/core/src/background-job.ts` Map never deletes
3. Log rotation cap — `data/log/` grows unbounded (781GB-class observed across installs)
4. `tool-output/` retention window — 5.3GB observed; needs a policy decision (old tool results stop rendering)
5. `PRAGMA auto_vacuum=INCREMENTAL` — see upstream #31526

See the fork section of `AGENTS.md` for the upkeep procedure and rollback recipe.
