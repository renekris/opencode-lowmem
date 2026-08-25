// Bounds whole-record session mirrors by count, size, and active-session protection.
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { serializedUtf8Bytes } from "./payload-budget"
import { readEnvLimit } from "@opencode-ai/core/util/env-limit"

export function createMirrorBudget(isActiveSession: () => string | undefined) {
  const budgetBytes = readEnvLimit("OPENCODE_TUI_MIRROR_BUDGET_MB", "64MB")
  const sessionLimit = readEnvLimit("OPENCODE_TUI_MIRROR_SESSION_LIMIT", "20", "count")
  const messageMaxBytes = readEnvLimit("OPENCODE_TUI_MIRROR_MSG_MAX_KB", "512KB")
  const sizes = new Map<string, number>()
  const lru: string[] = []
  let resident = 0
  let evictions = 0
  let lastWarning = 0

  function remove(sessionID: string) {
    resident -= sizes.get(sessionID) ?? 0
    sizes.delete(sessionID)
    const index = lru.indexOf(sessionID)
    if (index !== -1) lru.splice(index, 1)
  }

  return {
    replaceMirrorSessionMessages(sessionID: string, messages: readonly SessionMessage[]) {
      resident -= sizes.get(sessionID) ?? 0
      sizes.delete(sessionID)
      const index = lru.indexOf(sessionID)
      if (index !== -1) lru.splice(index, 1)
      lru.push(sessionID)
      const retained = messages.filter((message) => messageMaxBytes === 0 || serializedUtf8Bytes(message) <= messageMaxBytes)
      const bytes = retained.reduce((total, message) => total + serializedUtf8Bytes(message), 0)
      sizes.set(sessionID, bytes)
      resident += bytes
      const evictedSessions: string[] = []
      const activeSessionID = isActiveSession()
      while ((sessionLimit > 0 && lru.length > sessionLimit) || (budgetBytes > 0 && resident > budgetBytes)) {
        const oldestIndex = lru.findIndex((id) => id !== activeSessionID)
        const oldest = oldestIndex === -1 ? undefined : lru[oldestIndex]
        if (oldest === undefined) break
        remove(oldest)
        evictedSessions.push(oldest)
      }
      const protectedSessionIDs = lru.filter((id) => id === activeSessionID)
      const protectedResident = protectedSessionIDs.reduce((total, id) => total + (sizes.get(id) ?? 0), 0)
      const pressure =
        (sessionLimit > 0 && lru.length > sessionLimit) || (budgetBytes > 0 && resident > budgetBytes)
      if (evictedSessions.length > 0 || pressure) {
        evictions += evictedSessions.length
        const now = Date.now()
        if (now - lastWarning >= 60_000) {
          lastWarning = now
          console.warn("tui data mirror pressure", {
            component: "tui.data-mirror",
            budget: "OPENCODE_TUI_MIRROR_BUDGET_MB",
            evictableResident: resident - protectedResident,
            protectedResident,
            protectedSessionCount: protectedSessionIDs.length,
            protectedSessionIDs,
            count: lru.length,
            evictions,
            truncations: 0,
            sessionID,
          })
        }
      }
      return { messages: sizes.has(sessionID) ? retained : [], evictedSessions }
    },
  }
}
