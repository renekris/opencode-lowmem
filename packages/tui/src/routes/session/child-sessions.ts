import type { ChildInboundRank } from "./child-inbound"

type ChildSessionLike = {
  id: string
  parentID?: string
  time: { created: number }
}

export type ChildRankLookup = (sessionID: string) => ChildInboundRank | undefined

// Fork(lowmem): conveyor order = inbound-message rank first (a child moves only
// when it receives a user message), creation time as fallback for unranked rows.
// The id tie-break is DESCENDING because SessionID.descending() encodes later
// creation as a lexically smaller id within the same millisecond.
export function compareChildSessions(a: ChildSessionLike, b: ChildSessionLike, rank?: ChildRankLookup): number {
  const ra = rank?.(a.id)
  const rb = rank?.(b.id)
  const ka = ra?.at ?? a.time.created
  const kb = rb?.at ?? b.time.created
  if (ka !== kb) return ka - kb
  const oa = ra?.ordinal ?? -1
  const ob = rb?.ordinal ?? -1
  if (oa !== ob) return oa - ob
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
}

function childSessions(sessions: ChildSessionLike[], rank?: ChildRankLookup): ChildSessionLike[] {
  return sessions.filter((x) => x.parentID !== undefined).sort((a, b) => compareChildSessions(a, b, rank))
}

export const CHILD_CONVEYOR_LIMIT = 50

// Fork(lowmem): the conveyor shows at most the newest CHILD_CONVEYOR_LIMIT
// children. A viewed child outside the window is pinned in by displacing the
// window's oldest member, so the footer always renders a valid "N of 50".
export function childSessionWindow(
  sessions: ChildSessionLike[],
  rank?: ChildRankLookup,
  currentID?: string,
): ChildSessionLike[] {
  const ordered = childSessions(sessions, rank)
  const window = ordered.slice(-CHILD_CONVEYOR_LIMIT)
  if (currentID === undefined) return window
  if (window.some((x) => x.id === currentID)) return window
  const current = ordered.find((x) => x.id === currentID)
  if (!current) return window
  return [current, ...window.slice(1)].sort((a, b) => compareChildSessions(a, b, rank))
}

// Newest child session id (the conveyor tail), ignoring non-child rows.
export function newestChildSessionID(sessions: ChildSessionLike[], rank?: ChildRankLookup): string | undefined {
  return childSessionWindow(sessions, rank).at(-1)?.id
}

// Circular step through child sessions in conveyor order. direction +1
// moves toward the newest child, -1 toward the oldest; both ends wrap.
// An unknown currentID resolves to the oldest (+1) or newest (-1).
export function cycleChildSessionID(
  sessions: ChildSessionLike[],
  currentID: string | undefined,
  direction: 1 | -1,
  rank?: ChildRankLookup,
): string | undefined {
  const children = childSessionWindow(sessions, rank, currentID)
  if (children.length === 0) return undefined
  const current = children.findIndex((x) => x.id === currentID)
  if (current === -1) return children[direction === 1 ? 0 : children.length - 1].id
  const index = (current + direction + children.length) % children.length
  return children[index].id
}
