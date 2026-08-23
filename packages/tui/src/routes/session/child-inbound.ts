export type ChildInboundRank = { at: number; ordinal: number }

// Fork(lowmem): conveyor ranks update only when a child RECEIVES a user message,
// so tool rounds, permission asks, compaction, and metadata never reorder the list.
// Known deviations (accepted): plan-tool self-injections and compaction auto-continue
// replays also write user messages and will move the child.
const CAP = 256
const ranks = new Map<string, { at: number; ordinal: number; messageID: string }>()
let nextOrdinal = 0

export function noteInboundMessage(info: {
  id: string
  sessionID: string
  role: string
  time: { created: number }
}): void {
  if (info.role !== "user") return
  const current = ranks.get(info.sessionID)
  if (current && current.messageID === info.id) return
  ranks.delete(info.sessionID)
  ranks.set(info.sessionID, { at: info.time.created, ordinal: nextOrdinal++, messageID: info.id })
  if (ranks.size > CAP) {
    const oldest = ranks.keys().next().value
    if (oldest !== undefined) ranks.delete(oldest)
  }
}

export function inboundChildRank(sessionID: string): ChildInboundRank | undefined {
  const entry = ranks.get(sessionID)
  return entry === undefined ? undefined : { at: entry.at, ordinal: entry.ordinal }
}

export function forgetInboundChild(sessionID: string): void {
  ranks.delete(sessionID)
}
