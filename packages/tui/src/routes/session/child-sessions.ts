type ChildSessionLike = {
  id: string
  parentID?: string
  time: { created: number; updated: number }
}

// Fork(lowmem): child sessions use one conveyor order everywhere —
// last activity ascending (least recently active first, latest last),
// keyed on time.updated (bumped by Session.touch at every prompt). The
// id tie-break is DESCENDING because SessionID.descending() encodes
// later creation as a lexically smaller id within the same millisecond.
export function compareChildSessions(a: ChildSessionLike, b: ChildSessionLike): number {
  return a.time.updated - b.time.updated || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
}

function childSessions(sessions: ChildSessionLike[]): ChildSessionLike[] {
  return sessions.filter((x) => x.parentID !== undefined).sort(compareChildSessions)
}

// Newest child session id (the conveyor tail), ignoring non-child rows.
export function newestChildSessionID(sessions: ChildSessionLike[]): string | undefined {
  return childSessions(sessions).at(-1)?.id
}

// Circular step through child sessions in conveyor order. direction +1
// moves toward the newest child, -1 toward the oldest; both ends wrap.
// An unknown currentID resolves to the oldest (+1) or newest (-1).
export function cycleChildSessionID(
  sessions: ChildSessionLike[],
  currentID: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const children = childSessions(sessions)
  if (children.length === 0) return undefined
  const current = children.findIndex((x) => x.id === currentID)
  if (current === -1) return children[direction === 1 ? 0 : children.length - 1].id
  const index = (current + direction + children.length) % children.length
  return children[index].id
}
