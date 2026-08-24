import { produce, type SetStoreFunction } from "solid-js/store"
import { createPayloadBudget } from "./payload-budget"

type Message = { id: string; role: string; time: { created?: number; completed?: number } }
type SessionRow = { id: string; time: { compacting?: number } }
type Part = { id: string; sessionID: string }

type EvictableStore = {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  todo: Record<string, unknown[]>
  session_diff: Record<string, unknown[]>
  session_status: Record<string, { type: string }>
  permission: Record<string, unknown[]>
  question: Record<string, unknown[]>
  session: SessionRow[]
}

type EvictionDeps = {
  readonly fullSyncedSessions: Set<string>
  readonly syncingSessions: Map<string, unknown>
  readonly hydratingSessions: Map<string, unknown>
}

export function createPayloadEviction<T extends EvictableStore>(store: T, setStore: SetStoreFunction<T>, deps: EvictionDeps) {
  const evicted = new Set<string>()
  const deleted = new Set<string>()
  const deletionOrder: string[] = []
  const viewClock: string[] = []
  const evictingSessions = new Set<string>()
  const DELETED_TOMBSTONE_LIMIT = 1024
  let active: string | undefined
  let dropMessage: (messageID: string) => void = () => {}

  const budget = createPayloadBudget({
    isActive: (sessionID) => sessionID === active,
    isProtected: (sessionID) =>
      sessionID === active ||
      deps.syncingSessions.has(sessionID) ||
      deps.hydratingSessions.has(sessionID) ||
      evictingSessions.has(sessionID),
  })

  function viewed(sessionID: string) {
    evicted.delete(sessionID)
    const previous = viewClock.lastIndexOf(sessionID)
    if (previous !== -1) viewClock.splice(previous, 1)
    viewClock.push(sessionID)
  }

  function activate(sessionID: string) {
    active = sessionID
    viewed(sessionID)
    budget.refresh()
    compact()
  }

  function isEvicted(sessionID: string) {
    return evicted.has(sessionID)
  }

  function evictSessionPayload(sessionID: string) {
    evicted.add(sessionID)
    const messages = store.message[sessionID] ?? []
    const orphaned = Object.entries(store.part)
      .filter(([, parts]) => parts.some((part) => part.sessionID === sessionID))
      .map(([messageID]) => messageID)
    for (const messageID of budget.messageIDs(sessionID)) dropMessage(messageID)
    budget.removeSession(sessionID, { evicted: true })
    setStore(
      produce((draft: T) => {
        for (const message of messages) delete draft.part[message.id]
        for (const messageID of orphaned) delete draft.part[messageID]
        delete draft.message[sessionID]
        delete draft.todo[sessionID]
        delete draft.session_diff[sessionID]
      }),
    )
    deps.fullSyncedSessions.delete(sessionID)
  }

  function protectedFromEviction(sessionID: string) {
    return (
      sessionID === active ||
      deps.syncingSessions.has(sessionID) ||
      deps.hydratingSessions.has(sessionID) ||
      evictingSessions.has(sessionID)
    )
  }

  function compact() {
    budget.refresh()
    if (!budget.overLimit()) return
    const ranked = budget
      .sessionIDs()
      .filter((sessionID) => !evicted.has(sessionID))
      .map((sessionID) => ({ sessionID, rank: viewClock.lastIndexOf(sessionID) }))
      .sort((a, b) => a.rank - b.rank)
    for (const candidate of ranked) {
      if (!budget.overLimit()) return
      if (protectedFromEviction(candidate.sessionID)) continue
      budget.warnPressure(candidate.sessionID)
      evictingSessions.add(candidate.sessionID)
      evictSessionPayload(candidate.sessionID)
      evictingSessions.delete(candidate.sessionID)
    }
    budget.warnPressure(active ?? ranked[0]?.sessionID ?? "unknown")
  }

  function remarkEvicted(sessionID: string) {
    if (protectedFromEviction(sessionID)) return
    evictSessionPayload(sessionID)
  }

  function isDeleted(sessionID: string) {
    return deleted.has(sessionID)
  }

  function forgetSession(sessionID: string) {
    if (!deleted.has(sessionID)) {
      deleted.add(sessionID)
      deletionOrder.push(sessionID)
      if (deletionOrder.length > DELETED_TOMBSTONE_LIMIT) {
        const oldest = deletionOrder.shift()
        if (oldest !== undefined) deleted.delete(oldest)
      }
    }
    evicted.delete(sessionID)
    const previous = viewClock.lastIndexOf(sessionID)
    if (previous !== -1) viewClock.splice(previous, 1)
    const messages = store.message[sessionID] ?? []
    const orphaned = Object.entries(store.part)
      .filter(([, parts]) => parts.some((part) => part.sessionID === sessionID))
      .map(([messageID]) => messageID)
    for (const messageID of budget.messageIDs(sessionID)) dropMessage(messageID)
    budget.removeSession(sessionID)
    setStore(
      produce((draft: T) => {
        for (const message of messages) delete draft.part[message.id]
        for (const messageID of orphaned) delete draft.part[messageID]
        delete draft.message[sessionID]
        delete draft.todo[sessionID]
        delete draft.session_diff[sessionID]
        delete draft.session_status[sessionID]
        delete draft.permission[sessionID]
        delete draft.question[sessionID]
      }),
    )
    deps.fullSyncedSessions.delete(sessionID)
  }

  return {
    budget,
    activate,
    viewed,
    isEvicted,
    compact,
    remarkEvicted,
    forgetSession,
    isDeleted,
    setDropMessage(value: (messageID: string) => void) {
      dropMessage = value
    },
  }
}
