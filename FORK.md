# opencode-lowmem

A resource-bounded build of [opencode](https://github.com/anomalyco/opencode): full
capability, bounded memory. This fork carries local patches plus ports of upstream
community PRs that fix real resource and reliability problems but were never merged
upstream. Nothing is removed or gated — every change either **bounds a resource**
or **fixes a reliability defect**. The database format is untouched: your sessions,
auth, and config work across stock opencode and this fork interchangeably.

## Why

A single long-lived opencode process (many sessions, subagents, and delegation-heavy
workloads) was observed growing to 10+ GB RSS and silently hanging on flaky
gateways. Upstream fixes existed as unmerged PRs; this fork collects the best of
them, verified against real usage, plus original bounds-oriented work.

## What's inside

| Feature | Plain language | Developer detail |
|---|---|---|
| Bounded compacted-history hydration | After a context compaction, only the recent window is loaded; older history stays on disk until actually needed | port of [#39930](https://github.com/anomalyco/opencode/pull/39930) — a 609-message session materialized 11 MB; now ~0.8 MB |
| O(N) delta accumulation | Very long replies no longer slow down the longer they get | port of [#42150](https://github.com/anomalyco/opencode/pull/42150) — text/reasoning deltas were O(N²) string concatenation |
| PubSub listener leak fix | Subscriptions to finished streams are released | port of [#38939](https://github.com/anomalyco/opencode/pull/38939) — `allBounded` kept listeners alive |
| Config cache isolation | Two projects open at once can't corrupt each other's settings | port of [#41950](https://github.com/anomalyco/opencode/pull/41950) — global config cache mutated across workspaces |
| Empty-stream retry | A gateway that closes cleanly with no content retries instead of silently ending your turn | port of [#43881](https://github.com/anomalyco/opencode/pull/43881) — `finishReason: unknown` + 0 output tokens now raises a retryable error |
| Stream failures marked as errors | Failed streams are recorded as errored, not as normal stops | port of [#42176](https://github.com/anomalyco/opencode/pull/42176) — error path sets `finish: "error"` |
| Honest SSE chunk timeout | Server keepalive comments can no longer fake "data is flowing" during a stall | port of [#43607](https://github.com/anomalyco/opencode/pull/43607) — one deadline per stream, reset only on complete `data:` events |
| Diff-patch caps | Snapshots of large edits can't balloon memory/disk | customs — per-patch 100 KB, 256 KB aggregate, summaries store metadata and recompute on read |
| Subagent tab eviction | The subagent list keeps the newest 50 finished agents instead of every one ever spawned; anything needing your input (permission prompts) is never evicted and evicted agents come back if they ask again | customs — keep-last-N with running/pinned/blocker exemptions, revival on queued prompts, oldest-first "conveyor" ordering |
| Conveyor navigation | Tab/arrow navigation through child sessions follows creation order, consistent between footer and session list | customs — shared `compareChildSessions` ordering with causal same-millisecond tie-break |
| Git subcommand classifier | "Always allow" for `git -C ../worktree commit` stores `git commit *` — not junk, and never a wider grant than you approved | custom — env/command unwrapping + git global-option skipping + scoped patterns |

Full provenance, rebase/durability policy, and the not-ported list with reasons:
[PORTS.md](PORTS.md).

## Install

Requires [bun](https://bun.sh). From a clone:

```bash
./scripts/fork-build.sh
```

Builds all platform targets, stamps the version (`<upstream>-lowmem.<round>` from
git tags), smoke-tests, and tags the build. Running sessions are never killed.

## Updating from upstream

See the fork section of [AGENTS.md](AGENTS.md) for the upkeep procedure and
rollback recipe. Short version: rebase onto the new upstream tag, the port
manifest tells you exactly which seams to re-check, and behavior-pinning tests
fail loudly if an upstream refactor moved a hunk.

## Credit

All ported work is credited in [PORTS.md](PORTS.md) and in each commit's
`(port of upstream #NNNNN)` trailer. Upstream authors did the hard diagnosis;
this fork just ships it.
