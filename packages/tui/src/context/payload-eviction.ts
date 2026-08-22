import { produce, type SetStoreFunction } from "solid-js/store"

type Message = { id: string; role: string; time: { created?: number; completed?: number } }
type SessionRow = { id: string; time: { compacting?: number } }
type SessionStatus = { type: string }
type Part = { id: string; sessionID: string }

type EvictableStore = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  todo: Record<string, unknown[]>
  session_diff: Record<string, unknown[]>
  session_status: Record<string, SessionStatus>
  permission: Record<string, unknown[]>
  question: Record<string, unknown[]>
  session: SessionRow[]
}

type EvictionDeps = {
  fullSyncedSessions: Set<string>
  syncingSessions: Map<string, unknown>
  hydratingSessions: Map<string, unknown>
}

// Fork(lowmem): TUI payload eviction. Session rows, statuses, permissions and
// questions stay complete; heavy message/part/todo/diff payloads for sessions
// viewed out are dropped and re-hydrate via session.sync() on re-entry.
const VIEWED_PAYLOAD_LIMIT = 20

export function createPayloadEviction<T extends EvictableStore>(
  store: EvictableStore,
  setStore: SetStoreFunction<T>,
  deps: EvictionDeps,
) {
  const evicted = new Set<string>()
  const viewClock: string[] = []
  let active: string | undefined

  // Hydration observation: records recency only. Route activation is separate
  // so child-preview syncs cannot steal protection from the displayed route.
  function viewed(sessionID: string) {
    evicted.delete(sessionID)
    const previous = viewClock.lastIndexOf(sessionID)
    if (previous !== -1) viewClock.splice(previous, 1)
    viewClock.push(sessionID)
  }

  function activate(sessionID: string) {
    active = sessionID
    viewed(sessionID)
  }

  function isEvicted(sessionID: string) {
    return evicted.has(sessionID)
  }

  function protectedFromEviction(sessionID: string): boolean {
    if (sessionID === active) return true
    if (deps.syncingSessions.has(sessionID) || deps.hydratingSessions.has(sessionID)) return true
    const status = store.session_status[sessionID]
    if (status !== undefined && status.type !== "idle") return true
    if ((store.permission[sessionID] ?? []).length > 0) return true
    if ((store.question[sessionID] ?? []).length > 0) return true
    if (store.session.find((item) => item.id === sessionID)?.time.compacting) return true
    const messages = store.message[sessionID] ?? []
    const last = messages.at(-1)
    if (last && (last.role === "user" || !last.time.completed)) return true
    return false
  }

  function evictSessionPayload(sessionID: string) {
    evicted.add(sessionID)
    // Sweep part buckets by sessionID: message.removed can orphan a bucket
    // from the message list, so message-derived keys alone would leak it.
    const orphaned = Object.entries(store.part)
      .filter(([, parts]) => parts.some((part) => part.sessionID === sessionID))
      .map(([messageID]) => messageID)
    setStore(
      produce((draft: T) => {
        for (const message of store.message[sessionID] ?? []) delete draft.part[message.id]
        for (const messageID of orphaned) delete draft.part[messageID]
        delete draft.message[sessionID]
        delete draft.todo[sessionID]
        delete draft.session_diff[sessionID]
      }),
    )
    deps.fullSyncedSessions.delete(sessionID)
  }

  // Scan every candidate: protected oldest entries must not stop the scan,
  // otherwise enough protected sessions disables eviction entirely.
  function compact() {
    const payloadSessions = Object.keys(store.message)
    const excess = payloadSessions.length - VIEWED_PAYLOAD_LIMIT
    if (excess <= 0) return
    const ranked = payloadSessions
      .filter((sessionID) => !evicted.has(sessionID))
      .map((sessionID) => ({ sessionID, rank: viewClock.lastIndexOf(sessionID) }))
      .sort((a, b) => a.rank - b.rank)
    let removed = 0
    for (const candidate of ranked) {
      if (removed >= excess) break
      if (protectedFromEviction(candidate.sessionID)) continue
      evictSessionPayload(candidate.sessionID)
      removed++
    }
  }

  // Failure-path re-arm: a hydration that rejected after clearing the
  // evicted flag must gate again, but never for protected sessions.
  function remarkEvicted(sessionID: string) {
    if (protectedFromEviction(sessionID)) return
    evictSessionPayload(sessionID)
  }

  return { activate, viewed, isEvicted, compact, remarkEvicted }
}
