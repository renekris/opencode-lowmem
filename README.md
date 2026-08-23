# opencode-lowmem

> **The same agent, bounded memory.** Built after a real workday ended with
> 50+ finished subagent tabs that nothing ever freed and a process past
> **12 GB RSS** — the same workload now runs at a fraction of that. Nothing is
> removed or gated: every change bounds a resource or fixes a reliability defect.

The database format is untouched — sessions, auth, and config work
interchangeably with stock opencode. Plugins work unchanged too: this fork is
built and dogfooded daily with the
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) plugin toolkit.

## Why this fork exists

One heavy delegation day: 50+ finished subagent tabs sitting in the UI forever,
a process that had crept past 12 GB on a 28 GB machine, and a swap partition
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
git log --oneline v1.18.21..HEAD -- <file-path>   # everything touching a seam
```

## Ported upstream fixes (never merged upstream)

| Fix | Plain language | Upstream | Author |
|---|---|---|---|
| Bounded compacted-history hydration | After context compaction, only the recent window loads; old history stays on disk until needed — a 609-message session materialized 11 MB, now ~0.8 MB | [#39930](https://github.com/anomalyco/opencode/pull/39930) | **brauliobo** |
| O(N) delta accumulation | Very long replies no longer get slower the longer they run (processor side) | [#42150](https://github.com/anomalyco/opencode/pull/42150) | **hardes11** |
| PubSub listener leak fix | Subscriptions to finished streams are released (local deviation: listeners keep Array semantics so duplicate registrations deliver independently) | [#38939](https://github.com/anomalyco/opencode/pull/38939) | **Shalin-Shah-2002** |
| Config cache isolation | Two projects open at once can't corrupt each other's settings | [#41950](https://github.com/anomalyco/opencode/pull/41950) | **weiconghe** |
| Empty-stream retry | A gateway that closes cleanly with no content retries instead of silently ending your turn; we add a clean-EOF regression test and an observed-output guard so a stream that already emitted text is never retried | [#43881](https://github.com/anomalyco/opencode/pull/43881) | **moritzscheele** |
| Stream failures marked errored | Failed streams are recorded as errored, not as normal stops | [#42176](https://github.com/anomalyco/opencode/pull/42176) | **vladislav-miroshnikov** |
| Honest SSE chunk timeout | Server keepalive comments can't fake "data is flowing" during a stall; we add a multi-byte-split regression test | [#43607](https://github.com/anomalyco/opencode/pull/43607) | **1052326311** |
| PartUpdated shallow copy | Parts stop being deep-cloned on every publish — a top RAM driver in long sessions (issue [#35107](https://github.com/anomalyco/opencode/issues/35107) by **xingruodong-sys**; fix shape from closed [#43733](https://github.com/anomalyco/opencode/pull/43733) by **ColeLindfors**) | #35107 / #43733 | credited here |

Each port commit carries a `(port of upstream #NNNNN)` trailer — never dropped.

## Original fork work (customs)

| Feature | Plain language | Detail |
|---|---|---|
| Diff-patch caps | Snapshots of large edits can't balloon memory and disk | per-patch 100 KB, 256 KB aggregate; generated-path denylist; summaries store metadata and recompute on read |
| Run-UI subagent tab eviction | The run-mode subagent list keeps the newest 50 finished agents, not every one ever spawned | running, pinned, and permission-holding sessions exempt; evicted agents revive if they ask again; synthetic-gated background settlement |
| TUI payload eviction | Sessions you navigate away from drop their message/part payloads from memory (keep-last-~20 viewed); they rehydrate on return | guards for active/running/permission/in-flight sessions; failed revival re-arms; plugin getters auto-refetch |
| Child conveyor (daily TUI) | Child sessions reorder only when they *receive* a message — delegation, task continuation, or direct input; tool rounds, permissions, and compaction never shuffle the list | client-side rank map (bounded 256, roots excluded); newest-50 window; viewed out-of-window child pins in; footer shows an honest N of 50 |
| TUI delta coalescing | The UI-side twin of #42150: streamed chunks coalesce and apply every 120 ms instead of quadratic per-chunk store writes — for every session in the process, background subagents included | `packages/tui/src/context/part-delta-buffer.ts`; authoritative part/message updates drop pending buffers |
| Deleted-session cleanup | Deleting a session actually drops its message/part/diff/status buckets from the UI store (upstream [#12351](https://github.com/anomalyco/opencode/issues/12351), reported by **Limme-swe**) | `session.deleted` handler in `packages/tui/src/context/sync.tsx` |
| Git subcommand classifier | "Always allow" for `git -C ../worktree commit` stores `git commit *` — never junk, never a wider grant than you approved | env/command unwrapping + git global-option skipping + scoped patterns |

## Deliberately NOT ported

| Upstream PR | Reason |
|---|---|
| #40861 (summary diffs metadata-only) | superseded by the diff-cap customs (same design, recompute fallback) |
| #42771 (event payload → side table) | only remaining schema change; revisit if event-table disk growth becomes acute |
| #43455 (snapshot retry/circuit breaker) | robustness not memory; conflicts with diff-cap customs' surface |
| #22428 (PRAGMA mmap_size=0) | no-op on Linux; macOS-targeted |
| #16695 (memory-leak consolidation) | closed unmerged by stalebot; useful pieces (LSP LRU) belong in fork customs instead |
| #33713 (idle instance eviction) | dormant upstream, wrong shape for multi-process usage |

## Install

### One-liner (prebuilt binaries from GitHub Releases)

```bash
curl -fsSL https://raw.githubusercontent.com/renekris/opencode-lowmem/lowmem/scripts/fork-install.sh | bash
```

Detects your platform, verifies the SHA-256 digest against the release asset,
and installs to `~/.opencode/bin/opencode`. Running sessions are never killed;
new sessions pick up the new build.

### Build from source

Requires [bun](https://bun.sh):

```bash
git clone https://github.com/renekris/opencode-lowmem
cd opencode-lowmem
./scripts/fork-build.sh
```

Builds all platform targets, stamps the version (`<upstream>-lowmem.<round>`
from git tags — round = highest existing + 1), smoke-tests, and tags the build.

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
  `updatePart` (#35107)
- `packages/opencode/src/cli/cmd/run/subagent-data.ts` + `stream.transport.ts` —
  run-UI eviction (settle/revive/compact helpers; small transport delta)
- `packages/tui/src/context/sync.tsx` — four marked `Fork(lowmem)` hunks:
  delta-buffer wiring, inbound-rank hook + root purge, `session.deleted`
  cleanup, eviction-gate breaks
- `packages/tui/src/routes/session/index.tsx`, `subagent-footer.tsx` —
  conveyor call-site injections only

**Watch-list** (adopt upstream if merged, replacing our port): #39970
(comprehensive stream-incomplete handling, supersedes #43881/#43607), #41466
(same empty-stream bug via new error type), #40142 (finish=length loop exit),
#43302 (v2 sync engine — design-borrow only).

**Backlog** (unclaimed, no upstream equivalent): LSP files LRU
(`packages/opencode/src/lsp/client.ts` store is set-never-deleted);
BackgroundJob settled-entry eviction (`packages/core/src/background-job.ts`);
per-session Effect EventTarget listener leak (upstream #29204, no fix PR);
log rotation cap; `tool-output/` retention policy; `PRAGMA auto_vacuum`.

## Credit

All ported work is credited in the tables above and in each commit's
`(port of upstream #NNNNN)` trailer. Upstream authors did the hard diagnosis;
this fork just ships it.

## About upstream

This fork builds on [opencode](https://github.com/anomalyco/opencode) — the open
source AI coding agent, pinned at `v1.18.21`. See the
[upstream README](https://github.com/anomalyco/opencode/tree/dev#readme) for
everything not fork-specific.
