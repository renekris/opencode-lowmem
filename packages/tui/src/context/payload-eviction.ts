import { produce, type SetStoreFunction } from "solid-js/store"
import { createPayloadBudget } from "./payload-budget"

type Message = { id: string; role: string; time: { created?: number; completed?: number } }
type SessionRow = { id: string; parentID?: string; time: { compacting?: number } }
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
  const ROOT_HOT_WINDOW_MAX_BYTES = 128 * 1024 * 1024
  const evicted = new Set<string>()
  const emergencyEvicted = new Set<string>()
  const deleted = new Set<string>()
  const deletionOrder: string[] = []
  const viewClock: string[] = []
  const evictingSessions = new Set<string>()
  const DELETED_TOMBSTONE_LIMIT = 1024
  let active: string | undefined
  let dropMessage: (messageID: string) => void = () => {}
  const protectedFromEviction = (sessionID: string) =>
    sessionID === active ||
    deps.syncingSessions.has(sessionID) ||
    deps.hydratingSessions.has(sessionID) ||
    evictingSessions.has(sessionID)

  function hotRoot(): string | undefined {
    if (active === undefined) return undefined
    const visited = new Set<string>()
    let sessionID = active
    while (true) {
      if (visited.has(sessionID)) return undefined
      visited.add(sessionID)
      const session = store.session.find((item) => item.id === sessionID)
      if (session === undefined) return undefined
      if (session.parentID === undefined) return session.id
      sessionID = session.parentID
    }
  }

  const protectedFromOrdinaryEviction = (sessionID: string) =>
    protectedFromEviction(sessionID) || sessionID === hotRoot()

  const budget = createPayloadBudget({
    isActive: (sessionID) => sessionID === active,
    isProtected: protectedFromOrdinaryEviction,
  })

  function viewed(sessionID: string) {
    if (emergencyEvicted.has(sessionID)) return false
    evicted.delete(sessionID)
    const previous = viewClock.lastIndexOf(sessionID)
    if (previous !== -1) viewClock.splice(previous, 1)
    viewClock.push(sessionID)
    return true
  }

  function activate(sessionID: string) {
    active = sessionID
    emergencyEvicted.delete(sessionID)
    viewed(sessionID)
    budget.refresh()
    compact()
  }

  function isEvicted(sessionID: string) {
    return evicted.has(sessionID) || emergencyEvicted.has(sessionID)
  }

  function removeMessageBucket(sessionID: string, messageID: string) {
    dropMessage(messageID)
    budget.removeMessage(sessionID, messageID)
    budget.removeParts(messageID)
    setStore(
      produce((draft: T) => {
        const messages = draft.message[sessionID]
        const index = messages?.findIndex((message) => message.id === messageID) ?? -1
        if (messages && index >= 0) messages.splice(index, 1)
        delete draft.part[messageID]
      }),
    )
  }

  function evictSessionPayload(sessionID: string, emergency = false) {
    if (emergency) emergencyEvicted.add(sessionID)
    if (!emergency) evicted.add(sessionID)
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

  function trimHotRoot() {
    const sessionID = hotRoot()
    const budgetBytes = budget.limits.budgetBytes
    if (sessionID === undefined || budgetBytes === 0) return
    if (sessionID === active) return
    if (
      deps.syncingSessions.has(sessionID) ||
      deps.hydratingSessions.has(sessionID) ||
      evictingSessions.has(sessionID)
    )
      return
    const cap = Math.min(ROOT_HOT_WINDOW_MAX_BYTES, Math.floor(budgetBytes / 2))
    const completed = (store.message[sessionID] ?? []).filter((message) => message.time.completed !== undefined)
    for (const message of completed.slice(0, -1)) {
      if (budget.sessionBytes(sessionID) <= cap) return
      removeMessageBucket(sessionID, message.id)
    }
    if (budget.sessionBytes(sessionID) <= cap) return
    budget.warnPressure(sessionID, true, "root-emergency-eviction")
    evictingSessions.add(sessionID)
    evictSessionPayload(sessionID, true)
    evictingSessions.delete(sessionID)
  }

  function compact() {
    budget.refresh()
    const ranked = budget
      .sessionIDs()
      .filter((sessionID) => !isEvicted(sessionID))
      .map((sessionID) => ({ sessionID, rank: viewClock.lastIndexOf(sessionID) }))
      .sort((a, b) => a.rank - b.rank)
    if (budget.overLimit()) {
      for (const candidate of ranked) {
        if (!budget.overLimit()) break
        if (protectedFromOrdinaryEviction(candidate.sessionID)) continue
        budget.warnPressure(candidate.sessionID)
        evictingSessions.add(candidate.sessionID)
        evictSessionPayload(candidate.sessionID)
        evictingSessions.delete(candidate.sessionID)
      }
    }
    trimHotRoot()
    budget.refresh()
    if (!budget.overLimit()) return
    budget.warnPressure(active ?? ranked[0]?.sessionID ?? "unknown")
  }

  function remarkEvicted(sessionID: string) {
    if (emergencyEvicted.has(sessionID)) return
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
    emergencyEvicted.delete(sessionID)
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
