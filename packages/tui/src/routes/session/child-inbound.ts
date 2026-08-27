import { createSignal } from "solid-js"

export type ChildInboundRank = { at: number; ordinal: number }

type InboundMessageInfo = {
  id: string
  sessionID: string
  role: string
  time: { created: number }
}

type RankEntry = { at: number; ordinal: number; messageID: string }
type DeferredEntry = { at: number; messageID: string }

// Fork(lowmem): the conveyor ranks children by their LATEST inbound user
// message, so a task_id continuation or human follow-up moves the lane to
// the tail where the user expects new work. Two stability rules keep the
// old freeze behavior where it mattered:
//   - the VIEWED child is pinned: while pinned its rank never changes, and
//     newer messages park as one deferred entry (latest wins) that applies
//     on unpin — footer math stays stable under the cursor;
//   - duplicated or out-of-order events never move a rank backwards.
// The map still ranks at most the first CAP distinct children (update in
// place, never evict); deletion frees a slot and clears pin/deferred state.
const CAP = 256
const ranks = new Map<string, RankEntry>()
const deferred = new Map<string, DeferredEntry>()
let nextOrdinal = 0
let pinned: string | undefined
const [rankVersion, setRankVersion] = createSignal(0)

function isNewer(info: InboundMessageInfo, entry: { at: number; messageID: string } | undefined): boolean {
  if (entry === undefined) return true
  if (info.time.created !== entry.at) return info.time.created > entry.at
  return info.id !== entry.messageID
}

function applyRank(info: InboundMessageInfo): void {
  const existing = ranks.get(info.sessionID)
  if (!isNewer(info, existing)) return
  if (existing === undefined && ranks.size >= CAP) return
  ranks.set(info.sessionID, { at: info.time.created, ordinal: nextOrdinal++, messageID: info.id })
  setRankVersion((version) => version + 1)
}

function commitDeferred(sessionID: string): void {
  const entry = deferred.get(sessionID)
  deferred.delete(sessionID)
  if (entry === undefined) return
  applyRank({ id: entry.messageID, sessionID, role: "user", time: { created: entry.at } })
}

export function noteInboundMessage(info: InboundMessageInfo): void {
  if (info.role !== "user") return
  if (info.sessionID === pinned) {
    const current = deferred.get(info.sessionID)
    if (isNewer(info, current)) deferred.set(info.sessionID, { at: info.time.created, messageID: info.id })
    return
  }
  applyRank(info)
}

export function setViewedChild(sessionID: string | undefined): void {
  if (sessionID === pinned) return
  const previous = pinned
  pinned = sessionID
  if (previous !== undefined) commitDeferred(previous)
}

export function inboundChildRank(sessionID: string): ChildInboundRank | undefined {
  rankVersion()
  const entry = ranks.get(sessionID)
  return entry === undefined ? undefined : { at: entry.at, ordinal: entry.ordinal }
}

export function forgetInboundChild(sessionID: string): void {
  const hadRank = ranks.delete(sessionID)
  const hadDeferred = deferred.delete(sessionID)
  if (sessionID === pinned) pinned = undefined
  if (hadRank || hadDeferred) setRankVersion((version) => version + 1)
}
