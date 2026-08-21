# Fork Port Manifest — `port/ram-fixes`

This fork is a resource-bounded build of [anomalyco/opencode](https://github.com/anomalyco/opencode):
full capability, bounded footprint. It carries local patches plus ports of upstream
community PRs that were never merged. **All ported work is credited here and must stay
credited** — if a port later becomes redundant (upstream merges it), mark it `ADOPTED
UPSTREAM at vX.Y.Z` below rather than deleting the row.

Base: `v1.18.21` (`826d9ad46a`). Fork lineage: `local-diff-caps` → `port/ram-fixes`.

## Ported upstream PRs

| Upstream PR | Author | Title | Our commit | Status |
|---|---|---|---|---|
| [#39930](https://github.com/anomalyco/opencode/pull/39930) | **brauliobo** | fix(session): bound compacted history hydration | `a95c3c9175` | ported 2026-08-22 |
| [#42150](https://github.com/anomalyco/opencode/pull/42150) | **hardes11** | fix(opencode): O(N) text/reasoning delta accumulation | `73cedfe502` | ported 2026-08-22 |
| [#38939](https://github.com/anomalyco/opencode/pull/38939) | **Shalin-Shah-2002** | fix(core): prevent allBounded listener leak via PubSub subscription | `74df05e463` | ported 2026-08-22 |
| [#41950](https://github.com/anomalyco/opencode/pull/41950) | **weiconghe** | fix(config): clone global cache to prevent cross-workspace mutation leak | `79f27203e1` | ported 2026-08-22 |

Each port commit message carries `(port of upstream #NNNNN)`; do not drop that trailer.

## Local customs (authored in this fork)

| Commit | Title | Bounds |
|---|---|---|
| `d96a51646e` | fix(opencode): cap stored snapshot diff patches | per-patch 100KB, generated-path denylist, 4k-line rule |
| `b89cf97a35` | fix(opencode): cap aggregate stored diff patches | 256KB cumulative per snapshot op |
| `dd77d3619d` | fix(opencode): avoid storing summary diff patches | summary diffs store metadata; recompute on read |
| `7d6933befb` | fix(permission): classify git subcommands | env/-C/-c wrapper-aware git subcommand classification |

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
3. Subagent list keep-last-N — `SubagentData.tabs/details` grow unbounded
4. Log rotation cap — `data/log/` grows unbounded (781GB-class observed across installs)
5. `tool-output/` retention window — 5.3GB observed; needs a policy decision (old tool results stop rendering)
6. `PRAGMA auto_vacuum=INCREMENTAL` — see upstream #31526

See the fork section of `AGENTS.md` for the upkeep procedure and rollback recipe.
