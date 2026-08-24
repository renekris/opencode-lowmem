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
| Durable event codec reuse           | Event codecs are compiled once per definition and cached instead of being rebuilt on every encode/decode — cuts CPU and allocation churn on the hot event path (129 M read syscalls observed on a 2.5 h session)                                                                     | [#43778](https://github.com/anomalyco/opencode/pull/43778) | app/opencode-agent\*       |

Each port commit carries a `(port of upstream #NNNNN)` trailer — never dropped.
\*AI-authored upstream PR; credited here in prose only.

## Original fork work (customs)

| Feature                      | Plain language                                                                                                                                                                                                                                                                                                                     | Detail                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Diff-patch caps              | Snapshots of large edits can't balloon memory and disk                                                                                                                                                                                                                                                                             | per-patch 100 KB, 256 KB aggregate; generated-path denylist; summaries store metadata and recompute on read                              |
| Run-UI subagent tab eviction | The run-mode subagent list keeps the newest 50 finished agents, not every one ever spawned                                                                                                                                                                                                                                         | running, pinned, and permission-holding sessions exempt; evicted agents revive if they ask again; synthetic-gated background settlement  |
| TUI payload eviction         | Sessions you navigate away from drop their message/part payloads from memory (keep-last-~20 viewed); they rehydrate on return                                                                                                                                                                                                      | guards for active/running/permission/in-flight sessions; failed revival re-arms; plugin getters auto-refetch                             |
| Child conveyor (daily TUI)   | Child sessions reorder only when they _receive_ a message — delegation, task continuation, or direct input; tool rounds, permissions, and compaction never shuffle the list                                                                                                                                                        | client-side rank map (bounded 256, roots excluded); newest-50 window; viewed out-of-window child pins in; footer shows an honest N of 50 |
| TUI delta coalescing         | The UI-side twin of #42150: streamed chunks coalesce and apply every 120 ms instead of quadratic per-chunk store writes — for every session in the process, background subagents included                                                                                                                                          | `packages/tui/src/context/part-delta-buffer.ts`; authoritative part/message updates drop pending buffers                                 |
| Deleted-session cleanup      | Deleting a session actually drops its message/part/diff/status/permission/question buckets from the UI store, tombstones the session so late events can't resurrect it, and a removed message drops its part bucket immediately (upstream [#12351](https://github.com/anomalyco/opencode/issues/12351), reported by **Limme-swe**) | `session.deleted`/`message.removed` handlers + tombstone gate in `packages/tui/src/context/sync.tsx`                                     |
| Git subcommand classifier    | "Always allow" for `git -C ../worktree commit` stores `git commit *` — never junk, never a wider grant than you approved                                                                                                                                                                                                           | env/command unwrapping + git global-option skipping + scoped patterns                                                                    |
| Payload byte+count budget    | TUI payload memory has a hard ceiling: when non-active session payloads exceed it, the least-recently-viewed ones drop (no auto-refetch); routing back rehydrates them. Streaming children keep working — their payloads drop only when non-active, and their status/permission events still flow. Permission prompts for evicted parts survive via a `toolInput` field carried on the permission event itself, so a prompt never needs its part payload resident | `packages/tui/src/context/payload-budget.ts`; knobs `OPENCODE_TUI_PAYLOAD_BUDGET_MB` (256), `OPENCODE_TUI_PAYLOAD_SESSION_LIMIT` (20), `OPENCODE_TUI_PART_INGRESS_MAX_KB` (256), `OPENCODE_TUI_DELTA_BUFFER_MAX_KB` (4096), `OPENCODE_TUI_DELTA_BUFFER_MAX_ENTRIES` (512), `OPENCODE_TUI_MIRROR_BUDGET_MB` (64), `OPENCODE_TUI_MIRROR_MSG_MAX_KB` (512); exact `"0"` disables each |
| LSP document LRU             | Open LSP documents (full text kept for incremental sync) are evicted least-recently-used with an explicit `didClose` — bounded by both count and bytes, refresh reads one file at a time, and diagnostics for closed docs are discarded via generation tokens                                                                                                                                                                                              | `packages/opencode/src/lsp/document-store.ts`; knobs `OPENCODE_LSP_DOC_LIMIT` (128), `OPENCODE_LSP_DOC_MAX_MB` (64), `OPENCODE_LSP_DOC_OPEN_ALLOWANCE_MB` (32); oversized docs open transiently then keep metadata-only records; exact `"0"` disables |

## Deliberately NOT ported

| Upstream PR                             | Reason                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| #40861 (summary diffs metadata-only)    | superseded by the diff-cap customs (same design, recompute fallback)                |
| #42771 (event payload → side table)     | only remaining schema change; revisit if event-table disk growth becomes acute      |
| #43455 (snapshot retry/circuit breaker) | robustness not memory; conflicts with diff-cap customs' surface                     |
| #22428 (PRAGMA mmap_size=0)             | no-op on Linux; macOS-targeted                                                      |
| #16695 (memory-leak consolidation)      | closed unmerged by stalebot; useful pieces (LSP LRU) belong in fork customs instead |
| #33713 (idle instance eviction)         | dormant upstream, wrong shape for multi-process usage                               |

## Install

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

**Deferred ports** (CPU winners, blocked on the next base bump): #43769
(parallel-session snapshot scan CPU −77%; PR authored against the post-split
`packages/ai`/`packages/util` tree that does not exist at v1.18.21) and
#40698 (TUI syntax-highlight LRU cache; wraps `getTreeSitterClient().highlightOnce`,
absent from our pinned `@opentui/core`). Verified 2026-08-24: both target
shapes missing at this base; porting now would mean inventing seams upstream
will replace. Already-merged perf PRs riding the next tag: #42826, #43292,
#42346, #42579, #42741, #42952, #43191, #43158, #42467, #42458, #42468,
#42972.

**Backlog** (unclaimed, no upstream equivalent): LSP files LRU
(`packages/opencode/src/lsp/client.ts` store is set-never-deleted);
BackgroundJob settled-entry eviction (`packages/core/src/background-job.ts`);
run-UI delta coalescing (`packages/opencode/src/cli/cmd/run/session-data.ts`
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
source AI coding agent, pinned at `v1.18.21`. See the
[upstream README](https://github.com/anomalyco/opencode/tree/dev#readme) for
everything not fork-specific.
