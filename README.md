# opencode-lowmem

> **The same agent, bounded memory.** Built after a real workday ended with
> 50+ finished subagent tabs that nothing ever freed and a process past
> **12 GB RSS** — the same workload now runs at **~1 GB**. Nothing is removed
> or gated: every change bounds a resource or fixes a reliability defect.

The database format is untouched — sessions, auth, and config work
interchangeably with stock opencode. Plugins work unchanged too: this fork is
built and dogfooded daily with the
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) plugin toolkit.

## Why this fork exists

One heavy delegation day: 50+ finished subagent tabs sitting in the UI forever,
a process that had crept past 12 GB on a 28 GB machine, and a swap partition
doing overtime. The stale tabs were the visible symptom — underneath, every
compaction re-materialized full session histories, text deltas accumulated
quadratically, multi-megabyte diff patches rode every update event, and
finished streams kept their listeners alive.

The fixes already existed as unmerged upstream PRs, plus a few small
bounds-oriented patches nobody had written yet. This fork ships all of them —
and keeps the newest 50 finished agents in the list instead of every one ever
spawned. Same machine, same day, same workload: stock build ~12 GB after hours;
this fork ~1 GB.

## What's in the fork

### Ported upstream fixes (never merged upstream)

| Fix | Plain language | Detail |
|---|---|---|
| Bounded compacted-history hydration | After context compaction, only the recent window loads; old history stays on disk until needed | [#39930](https://github.com/anomalyco/opencode/pull/39930) — a 609-message session materialized 11 MB; now ~0.8 MB |
| O(N) delta accumulation | Very long replies no longer get slower the longer they run | [#42150](https://github.com/anomalyco/opencode/pull/42150) — text/reasoning deltas were O(N²) string concatenation |
| PubSub listener leak fix | Subscriptions to finished streams are released | [#38939](https://github.com/anomalyco/opencode/pull/38939) — `allBounded` kept listeners alive forever |
| Config cache isolation | Two projects open at once can't corrupt each other's settings | [#41950](https://github.com/anomalyco/opencode/pull/41950) — global config cache mutated across workspaces |
| Empty-stream retry | A gateway that closes cleanly with no content retries instead of silently ending your turn | [#43881](https://github.com/anomalyco/opencode/pull/43881) — `finishReason: unknown` + 0 output tokens raises a retryable error (adds a regression test) |
| Stream failures marked errored | Failed streams are recorded as errored, not as normal stops | [#42176](https://github.com/anomalyco/opencode/pull/42176) — error path sets `finish: "error"` |
| Honest SSE chunk timeout | Server keepalive comments can't fake "data is flowing" during a stall | [#43607](https://github.com/anomalyco/opencode/pull/43607) — one deadline per stream, reset only on complete `data:` events |

### Original fork work (customs)

| Feature | Plain language | Detail |
|---|---|---|
| Diff-patch caps | Snapshots of large edits can't balloon memory and disk | per-patch 100 KB, 256 KB aggregate; summaries store metadata and recompute on read |
| Subagent tab eviction | The subagent list keeps the newest 50 finished agents, not every one ever spawned | running, pinned, and permission-holding sessions are exempt; evicted agents revive if they ask again; 256-entry revival memory |
| Git subcommand classifier | "Always allow" for `git -C ../worktree commit` stores `git commit *` — never junk, never a wider grant than you approved | env/command unwrapping + git global-option skipping + scoped patterns |

Provenance, per-round history, the durability/rebase policy, and the
deliberately-not-ported list: [PORTS.md](PORTS.md).

## Install

### One-liner (prebuilt binaries from GitHub Releases)

```bash
curl -fsSL https://raw.githubusercontent.com/renekris/opencode-lowmem/lowmem/scripts/fork-install.sh | bash
```

Detects your platform, downloads the matching release binary, installs to
`~/.opencode/bin/opencode`. Running sessions are never killed; new sessions pick
up the new build.

### Build from source

Requires [bun](https://bun.sh):

```bash
git clone https://github.com/renekris/opencode-lowmem
cd opencode-lowmem
./scripts/fork-build.sh
```

Builds all platform targets, stamps the version (`<upstream>-lowmem.<round>`
from git tags), smoke-tests, and tags the build.

### External tool installers

- **Homebrew**: not yet available. A `renekris/lowmem` tap with formulas
  pointing at the release binaries is the natural next step.
- **Direct download**: per-platform archives are attached to every
  [release](https://github.com/renekris/opencode-lowmem/releases).

## Updating from upstream

Rebase onto the new upstream tag. The port manifest ([PORTS.md](PORTS.md))
lists exactly which seams to re-check, and behavior-pinning tests fail loudly if
an upstream refactor moved a hunk. Fork upkeep procedure and rollback recipe:
fork section of [AGENTS.md](AGENTS.md).

## Credit

All ported work is credited in [PORTS.md](PORTS.md) and in each commit's
`(port of upstream #NNNNN)` trailer. Upstream authors did the hard diagnosis;
this fork just ships it.

## About upstream

This fork builds on [opencode](https://github.com/anomalyco/opencode) — the open
source AI coding agent. See the
[upstream README](https://github.com/anomalyco/opencode/tree/dev#readme) for
everything not fork-specific.
