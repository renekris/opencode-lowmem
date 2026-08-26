export type ChildInboundRank = { at: number; ordinal: number }

// Fork(lowmem): a child joins the conveyor at its FIRST inbound user message
// (the delegation that created it) and is never re-ranked afterwards —
// task_id continuations, compaction auto-continue replays, and plan-tool
// self-injections all write user-role messages but never move a ranked child.
// The map ranks at most the first CAP distinct children and never evicts:
// once full, later children keep ordering by creation time (equivalent for
// fresh delegations), and only an explicit deletion frees a slot. Human input
// targets the viewed child, which the window pins, so it stays stable too.
const CAP = 256
const ranks = new Map<string, { at: number; ordinal: number }>()
let nextOrdinal = 0

export function noteInboundMessage(info: {
  sessionID: string
  role: string
  time: { created: number }
}): void {
  if (info.role !== "user") return
  if (ranks.has(info.sessionID)) return
  if (ranks.size >= CAP) return
  ranks.set(info.sessionID, { at: info.time.created, ordinal: nextOrdinal++ })
}

export function inboundChildRank(sessionID: string): ChildInboundRank | undefined {
  const entry = ranks.get(sessionID)
  return entry === undefined ? undefined : { at: entry.at, ordinal: entry.ordinal }
}

export function forgetInboundChild(sessionID: string): void {
  ranks.delete(sessionID)
}
