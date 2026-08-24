import type { Part } from "@opencode-ai/sdk/v2"
import { parseEnvLimit, readEnvLimit, type EnvLimitUnit } from "../util/env-limit"

const encoder = new TextEncoder()
const WARNING_INTERVAL = 60_000

export { parseEnvLimit, readEnvLimit }
export type { EnvLimitUnit }

export function serializedUtf8Bytes(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return 0
  return encoder.encode(serialized).byteLength
}

export type PayloadBudgetStats = {
  readonly evictableResident: number
  readonly protectedResident: number
  readonly evictableSessionCount: number
  readonly protectedSessionCount: number
  readonly count: number
  readonly evictions: number
  readonly truncations: number
  readonly permissionBytes: number
}

export type PayloadBudget = ReturnType<typeof createPayloadBudget>

type PayloadBudgetOptions = {
  readonly budgetBytes?: number
  readonly sessionLimit?: number
  readonly activeAllowanceBytes?: number
  readonly permissionAllowanceBytes?: number
  readonly partIngressBytes?: number
  readonly isProtected?: (sessionID: string) => boolean
  readonly isActive?: (sessionID: string) => boolean
  readonly now?: () => number
  readonly warn?: (fields: Record<string, unknown>) => void
}

type StoredSize = { readonly sessionID: string; readonly bytes: number }

export function createPayloadBudget(options: PayloadBudgetOptions = {}) {
  const budgetBytes = options.budgetBytes ?? readEnvLimit("OPENCODE_TUI_PAYLOAD_BUDGET_MB", "256MB")
  const sessionLimit = options.sessionLimit ?? readEnvLimit("OPENCODE_TUI_PAYLOAD_SESSION_LIMIT", "20", "count")
  const activeAllowanceBytes =
    options.activeAllowanceBytes ?? readEnvLimit("OPENCODE_TUI_ACTIVE_ALLOWANCE_MB", "128MB")
  const permissionAllowanceBytes =
    options.permissionAllowanceBytes ?? readEnvLimit("OPENCODE_TUI_PERMISSION_ALLOWANCE_MB", "32MB")
  const partIngressBytes = options.partIngressBytes ?? readEnvLimit("OPENCODE_TUI_PART_INGRESS_MAX_KB", "256KB")
  const messages = new Map<string, StoredSize>()
  const parts = new Map<string, StoredSize>()
  const partSessions = new Map<string, string>()
  const todos = new Map<string, number>()
  const diffs = new Map<string, number>()
  const pending = new Map<string, StoredSize>()
  const sessions = new Set<string>()
  const permissionInputs = new Map<string, { readonly sessionID: string; readonly value: Record<string, unknown> }>()
  const permissionRequests = new Map<string, string>()
  const sessionPermissionKeys = new Map<string, Set<string>>()
  const truncatedParts = new Set<string>()
  let resident = new Map<string, number>()
  let evictableResident = 0
  let protectedResident = 0
  let evictableSessionCount = 0
  let protectedSessionCount = 0
  let evictions = 0
  let truncations = 0
  let permissionBytes = 0
  let lastWarning = 0

  function adjust(sessionID: string, delta: number) {
    const next = (resident.get(sessionID) ?? 0) + delta
    if (next === 0) resident.delete(sessionID)
    else resident.set(sessionID, next)
  }

  function refresh(sessionID?: string) {
    evictableResident = 0
    protectedResident = 0
    evictableSessionCount = 0
    protectedSessionCount = 0
    for (const id of sessions) {
      const bytes = resident.get(id) ?? 0
      if (options.isProtected?.(id) === true) {
        protectedResident += bytes
        protectedSessionCount++
      } else {
        evictableResident += bytes
        evictableSessionCount++
      }
    }
    if (sessionID !== undefined) warnPressure(sessionID)
  }

  function warnPressure(sessionID: string) {
    const activeBytes = options.isActive?.(sessionID) === true ? resident.get(sessionID) ?? 0 : 0
    const pressure =
      (budgetBytes > 0 && (evictableResident > budgetBytes || protectedResident > budgetBytes)) ||
      (activeAllowanceBytes > 0 && activeBytes > activeAllowanceBytes) ||
      (permissionAllowanceBytes > 0 && permissionBytes > permissionAllowanceBytes)
    if (!pressure) return
    const now = options.now?.() ?? Date.now()
    if (now - lastWarning < WARNING_INTERVAL) return
    lastWarning = now
    const warn = options.warn ?? ((fields: Record<string, unknown>) => console.warn("tui payload budget pressure", fields))
    warn({
        component: "tui.payload",
        budget: "OPENCODE_TUI_PAYLOAD_BUDGET_MB",
        evictableResident,
        protectedResident,
        count: sessions.size,
        evictions,
        truncations,
        sessionID,
        permissionBytes,
    })
  }

  function replaceMessage(sessionID: string, messageID: string, value: unknown | undefined) {
    const previous = messages.get(messageID)
    if (previous) adjust(previous.sessionID, -previous.bytes)
    if (value === undefined) messages.delete(messageID)
    else {
      sessions.add(sessionID)
      const bytes = serializedUtf8Bytes(value)
      messages.set(messageID, { sessionID, bytes })
      adjust(sessionID, bytes)
    }
    refresh(sessionID)
  }

  function replacePart(messageID: string, partID: string, sessionID: string, value: unknown | undefined) {
    const key = `${messageID}:${partID}`
    const previous = parts.get(key)
    if (previous) adjust(previous.sessionID, -previous.bytes)
    if (value === undefined) {
      parts.delete(key)
      if (![...parts.keys()].some((partKey) => partKey.startsWith(`${messageID}:`))) partSessions.delete(messageID)
    } else {
      const bytes = serializedUtf8Bytes(value)
      parts.set(key, { sessionID, bytes })
      partSessions.set(messageID, sessionID)
      sessions.add(sessionID)
      adjust(sessionID, bytes)
    }
    refresh(sessionID)
  }

  function replaceParts(messageID: string, sessionID: string, values: readonly Part[]) {
    for (const [key, value] of parts) {
      if (!key.startsWith(`${messageID}:`)) continue
      adjust(value.sessionID, -value.bytes)
      parts.delete(key)
      truncatedParts.delete(key)
    }
    partSessions.delete(messageID)
    for (const part of values) replacePart(messageID, part.id, sessionID, part)
    refresh(sessionID)
  }

  function replaceArray(target: Map<string, number>, sessionID: string, value: unknown[] | undefined) {
    adjust(sessionID, -(target.get(sessionID) ?? 0))
    if (value === undefined) target.delete(sessionID)
    else {
      const bytes = serializedUtf8Bytes(value)
      target.set(sessionID, bytes)
      sessions.add(sessionID)
      adjust(sessionID, bytes)
    }
    refresh(sessionID)
  }

  function removeParts(messageID: string) {
    const sessionID = [...parts].find(([key]) => key.startsWith(`${messageID}:`))?.[1].sessionID ?? pending.get(messageID)?.sessionID
    for (const [key, value] of parts) {
      if (!key.startsWith(`${messageID}:`)) continue
      adjust(value.sessionID, -value.bytes)
      parts.delete(key)
      truncatedParts.delete(key)
    }
    const pendingValue = pending.get(messageID)
    if (pendingValue) {
      adjust(pendingValue.sessionID, -pendingValue.bytes)
      pending.delete(messageID)
    }
    partSessions.delete(messageID)
    clearPermissionForMessage(messageID)
    if (sessionID !== undefined) refresh(sessionID)
  }

  function removeSession(sessionID: string, input: { readonly evicted?: boolean } = {}) {
    for (const [messageID, value] of messages) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      messages.delete(messageID)
      for (const key of [...truncatedParts]) if (key.startsWith(`${messageID}:`)) truncatedParts.delete(key)
    }
    for (const [key, value] of parts) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      parts.delete(key)
      truncatedParts.delete(key)
    }
    for (const [messageID, value] of pending) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      pending.delete(messageID)
    }
    adjust(sessionID, -(todos.get(sessionID) ?? 0) + -(diffs.get(sessionID) ?? 0))
    todos.delete(sessionID)
    diffs.delete(sessionID)
    clearPermissionSession(sessionID)
    partSessions.forEach((value, key) => value === sessionID && partSessions.delete(key))
    sessions.delete(sessionID)
    resident.delete(sessionID)
    if (input.evicted === true) evictions++
    refresh(sessionID)
  }

  function replacePendingDelta(messageID: string, bytes: number) {
    const sessionID = partSessions.get(messageID)
    if (sessionID === undefined) return
    const previous = pending.get(messageID)
    if (previous) adjust(sessionID, -previous.bytes)
    if (bytes === 0) pending.delete(messageID)
    else {
      pending.set(messageID, { sessionID, bytes })
      adjust(sessionID, bytes)
    }
    refresh(sessionID)
  }

  function replaceSession(
    sessionID: string,
    messageValues: readonly { readonly id: string }[],
    partValues: Record<string, readonly Part[]>,
    todo: unknown[] | undefined,
    diff: unknown[] | undefined,
  ) {
    for (const [messageID, value] of messages) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      messages.delete(messageID)
      clearTruncated(messageID)
    }
    for (const [key, value] of parts) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      parts.delete(key)
      truncatedParts.delete(key)
    }
    for (const [messageID, value] of pending) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      pending.delete(messageID)
    }
    adjust(sessionID, -(todos.get(sessionID) ?? 0) + -(diffs.get(sessionID) ?? 0))
    todos.delete(sessionID)
    diffs.delete(sessionID)
    partSessions.forEach((value, key) => value === sessionID && partSessions.delete(key))
    resident.delete(sessionID)
    sessions.add(sessionID)
    for (const message of messageValues) replaceMessage(sessionID, message.id, message)
    for (const [messageID, values] of Object.entries(partValues)) replaceParts(messageID, sessionID, values)
    replaceArray(todos, sessionID, todo)
    replaceArray(diffs, sessionID, diff)
    refresh(sessionID)
  }

  function markTruncated(key: string) {
    if (truncatedParts.has(key)) return
    truncatedParts.add(key)
    truncations++
  }

  function clearTruncated(messageID: string, partID?: string) {
    if (partID !== undefined) {
      truncatedParts.delete(`${messageID}:${partID}`)
      return
    }
    for (const key of [...truncatedParts]) if (key.startsWith(`${messageID}:`)) truncatedParts.delete(key)
  }

  function preparePart(sessionID: string, part: Part): Part {
    const key = `${part.messageID}:${part.id}`
    if (options.isActive?.(sessionID) === true || partIngressBytes === 0) {
      clearTruncated(part.messageID, part.id)
      return part
    }
    let result = part
    let exceeded = false
    const scalar = (value: string) => {
      if (serializedUtf8Bytes(value) <= partIngressBytes) return value
      exceeded = true
      markTruncated(key)
      return `[payload omitted by lowmem budget: ${serializedUtf8Bytes(value)} bytes]`
    }
    switch (part.type) {
      case "text":
        result = { ...part, text: scalar(part.text) }
        break
      case "reasoning":
        result = { ...part, text: scalar(part.text) }
        break
      case "tool":
        if (part.state.status === "completed") result = { ...part, state: { ...part.state, output: scalar(part.state.output) } }
        else clearTruncated(part.messageID, part.id)
        break
      case "file":
        if (part.source) result = { ...part, source: { ...part.source, text: { ...part.source.text, value: scalar(part.source.text.value) } } }
        else clearTruncated(part.messageID, part.id)
        break
      case "agent":
        if (part.source) result = { ...part, source: { ...part.source, value: scalar(part.source.value) } }
        else clearTruncated(part.messageID, part.id)
        break
      case "subtask":
      case "step-start":
      case "step-finish":
      case "snapshot":
      case "patch":
      case "retry":
      case "compaction":
        clearTruncated(part.messageID, part.id)
        break
      default:
        return part
    }
    if (!exceeded) clearTruncated(part.messageID, part.id)
    return result
  }

  function permissionKey(messageID: string, callID: string) {
    return `${messageID}:${callID}`
  }

  function setPermissionInput(sessionID: string, requestID: string, messageID: string, callID: string, value: Record<string, unknown>) {
    const key = permissionKey(messageID, callID)
    const requestKey = `${sessionID}:${requestID}`
    const previousKey = permissionRequests.get(requestKey)
    if (previousKey) clearPermissionKey(previousKey)
    clearPermissionKey(key)
    permissionInputs.set(key, { sessionID, value })
    permissionRequests.set(requestKey, key)
    const keys = sessionPermissionKeys.get(sessionID) ?? new Set<string>()
    keys.add(key)
    sessionPermissionKeys.set(sessionID, keys)
    permissionBytes += serializedUtf8Bytes(value)
    refresh(sessionID)
  }

  function clearPermissionKey(key: string) {
    const previous = permissionInputs.get(key)
    if (!previous) return
    permissionBytes -= serializedUtf8Bytes(previous.value)
    permissionInputs.delete(key)
    sessionPermissionKeys.get(previous.sessionID)?.delete(key)
  }

  function clearPermissionRequest(sessionID: string, requestID: string) {
    const requestKey = `${sessionID}:${requestID}`
    const key = permissionRequests.get(requestKey)
    if (key) clearPermissionKey(key)
    permissionRequests.delete(requestKey)
    refresh(sessionID)
  }

  function clearPermissionForMessage(messageID: string) {
    for (const key of [...permissionInputs.keys()]) if (key.startsWith(`${messageID}:`)) clearPermissionKey(key)
  }

  function clearPermissionSession(sessionID: string) {
    for (const key of sessionPermissionKeys.get(sessionID) ?? []) clearPermissionKey(key)
    sessionPermissionKeys.delete(sessionID)
    for (const key of [...permissionRequests.keys()]) if (key.startsWith(`${sessionID}:`)) permissionRequests.delete(key)
  }

  refresh()
  return {
    limits: { budgetBytes, sessionLimit, activeAllowanceBytes, permissionAllowanceBytes, partIngressBytes },
    replaceMessage,
    replacePart,
    replaceParts,
    replaceTodo: (sessionID: string, value: unknown[] | undefined) => replaceArray(todos, sessionID, value),
    replaceDiff: (sessionID: string, value: unknown[] | undefined) => replaceArray(diffs, sessionID, value),
    replaceSession,
    removeMessage: (sessionID: string, messageID: string) => {
      replaceMessage(sessionID, messageID, undefined)
      clearTruncated(messageID)
    },
    removePart: (messageID: string, partID: string) => {
      const sessionID = parts.get(`${messageID}:${partID}`)?.sessionID ?? partSessions.get(messageID)
      if (sessionID) replacePart(messageID, partID, sessionID, undefined)
      clearTruncated(messageID, partID)
      clearPermissionForMessage(messageID)
    },
    removeParts,
    removeSession,
    replacePendingDelta,
    preparePart,
    isTruncated: (messageID: string, partID: string) => truncatedParts.has(`${messageID}:${partID}`),
    setPermissionInput,
    permissionInput: (messageID: string, callID: string) => permissionInputs.get(permissionKey(messageID, callID))?.value,
    clearPermissionRequest,
    clearPermissionForMessage,
    clearPermissionSession,
    messageIDs: (sessionID: string) => {
      const result = new Set<string>()
      for (const [messageID, value] of messages) if (value.sessionID === sessionID) result.add(messageID)
      for (const [key, value] of parts) if (value.sessionID === sessionID) result.add(key.slice(0, key.indexOf(":")))
      for (const [messageID, value] of pending) if (value.sessionID === sessionID) result.add(messageID)
      return [...result]
    },
    sessionIDs: () => [...sessions],
    refresh,
    overLimit: () =>
      (budgetBytes > 0 && evictableResident > budgetBytes) || (sessionLimit > 0 && evictableSessionCount > sessionLimit),
    warnPressure,
    markEvicted: () => {
      evictions++
    },
    stats: (): PayloadBudgetStats => ({
      evictableResident,
      protectedResident,
      evictableSessionCount,
      protectedSessionCount,
      count: sessions.size,
      evictions,
      truncations,
      permissionBytes,
    }),
  }
}
