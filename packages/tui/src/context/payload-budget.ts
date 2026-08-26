import type { Part } from "@opencode-ai/sdk/v2"
import { parseEnvLimit, readEnvLimit, type EnvLimitUnit } from "@opencode-ai/core/util/env-limit"

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
  readonly permissionCount: number
  readonly permissionStoreBytes: number
  readonly questionStoreBytes: number
}

type PayloadBudgetOptions = {
  readonly budgetBytes?: number
  readonly sessionLimit?: number
  readonly activeAllowanceBytes?: number
  readonly activePartMaxBytes?: number
  readonly permissionAllowanceBytes?: number
  readonly permissionInputLimit?: number
  readonly partIngressBytes?: number
  readonly isProtected?: (sessionID: string) => boolean
  readonly isActive?: (sessionID: string) => boolean
  readonly now?: () => number
  readonly warn?: (fields: Record<string, unknown>) => void
}

type StoredSize = { readonly sessionID: string; readonly bytes: number }
type AppendablePart = Extract<Part, { readonly type: "text" | "reasoning" }>

function jsonStringContentBytes(value: string, start = 0) {
  let bytes = 0
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2
      continue
    }
    if (code < 0x20) {
      bytes += 6
      continue
    }
    if (code <= 0x7f) {
      bytes += 1
      continue
    }
    if (code <= 0x7ff) {
      bytes += 2
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
        continue
      }
      bytes += 6
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
      continue
    }
    bytes += 3
  }
  return bytes
}

function jsonStringAppendBytes(previousText: string, appendedText: string) {
  if (appendedText.length === 0) return 0
  const previousLast = previousText.charCodeAt(previousText.length - 1)
  const appendedFirst = appendedText.charCodeAt(0)
  if (previousLast >= 0xd800 && previousLast <= 0xdbff && appendedFirst >= 0xdc00 && appendedFirst <= 0xdfff) {
    return -2 + jsonStringContentBytes(appendedText, 1)
  }
  return jsonStringContentBytes(appendedText)
}

const permissionDisplayFields: ReadonlySet<string> = new Set([
  "filePath",
  "pattern",
  "path",
  "command",
  "subagent_type",
  "description",
  "url",
  "query",
  "provider",
])

function truncatePermissionInput(value: Record<string, unknown>, bytes: number): Record<string, unknown> {
  const marker = `[payload omitted by lowmem budget: ${bytes} bytes]`
  const keys = Object.keys(value).filter((key) => permissionDisplayFields.has(key))
  if (keys.length === 0) return { __lowmem: marker }
  return Object.fromEntries(keys.map((key) => [key, marker]))
}

export function truncatedPermissionInput() {
  const marker = "[payload omitted by lowmem budget]"
  return Object.fromEntries([...permissionDisplayFields].map((key) => [key, marker]))
}

export function createPayloadBudget(options: PayloadBudgetOptions = {}) {
  const budgetBytes = options.budgetBytes ?? readEnvLimit("OPENCODE_TUI_PAYLOAD_BUDGET_MB", "256MB")
  const sessionLimit = options.sessionLimit ?? readEnvLimit("OPENCODE_TUI_PAYLOAD_SESSION_LIMIT", "20", "count")
  const activeAllowanceBytes = options.activeAllowanceBytes ?? readEnvLimit("OPENCODE_TUI_ACTIVE_ALLOWANCE_MB", "128MB")
  const activePartMaxBytes = options.activePartMaxBytes ?? readEnvLimit("OPENCODE_TUI_ACTIVE_PART_MAX_MB", "32MB")
  const permissionAllowanceBytes =
    options.permissionAllowanceBytes ?? readEnvLimit("OPENCODE_TUI_PERMISSION_ALLOWANCE_MB", "32MB")
  const permissionMapAllowanceBytes = permissionAllowanceBytes * 2
  const permissionInputLimit =
    options.permissionInputLimit ?? readEnvLimit("OPENCODE_TUI_PERMISSION_INPUT_MAX_ENTRIES", "512", "count")
  const partIngressBytes = options.partIngressBytes ?? readEnvLimit("OPENCODE_TUI_PART_INGRESS_MAX_KB", "256KB")
  const messages = new Map<string, StoredSize>()
  const parts = new Map<string, StoredSize>()
  const partSessions = new Map<string, string>()
  const todos = new Map<string, number>()
  const diffs = new Map<string, number>()
  const pending = new Map<string, StoredSize>()
  const partCallIDs = new Map<string, string>()
  const sessions = new Set<string>()
  const permissionInputs = new Map<
    string,
    { readonly sessionID: string; readonly requestKey: string; readonly value: Record<string, unknown> }
  >()
  const permissionRequests = new Map<string, string>()
  const sessionPermissionKeys = new Map<string, Set<string>>()
  const truncatedParts = new Set<string>()
  const deltaParts = new Set<string>()
  const permissionStores = new Map<string, number>()
  const questionStores = new Map<string, number>()
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

  function warnPressure(sessionID: string, force = false) {
    const activeBytes = options.isActive?.(sessionID) === true ? (resident.get(sessionID) ?? 0) : 0
    const pressure =
      (budgetBytes > 0 && (evictableResident > budgetBytes || protectedResident > budgetBytes)) ||
      (activeAllowanceBytes > 0 && activeBytes > activeAllowanceBytes) ||
      (permissionAllowanceBytes > 0 && permissionBytes > permissionAllowanceBytes)
    if (!pressure && !force) return
    const now = options.now?.() ?? Date.now()
    if (now - lastWarning < WARNING_INTERVAL) return
    lastWarning = now
    const warn =
      options.warn ?? ((fields: Record<string, unknown>) => console.warn("tui payload budget pressure", fields))
    warn({
      component: "tui.payload",
      budget: "OPENCODE_TUI_PAYLOAD_BUDGET_MB",
      reason: pressure ? "pressure" : "permission-truncation",
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

  function replacePart(
    messageID: string,
    partID: string,
    sessionID: string,
    value: unknown | undefined,
    measuredBytes?: number,
  ) {
    const key = `${messageID}:${partID}`
    deltaParts.delete(key)
    const previous = parts.get(key)
    if (previous) adjust(previous.sessionID, -previous.bytes)
    if (value === undefined) {
      parts.delete(key)
      partCallIDs.delete(key)
      if (![...parts.keys()].some((partKey) => partKey.startsWith(`${messageID}:`))) partSessions.delete(messageID)
    } else {
      const bytes = measuredBytes ?? serializedUtf8Bytes(value)
      parts.set(key, { sessionID, bytes })
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "tool" &&
        "callID" in value &&
        typeof value.callID === "string"
      ) {
        partCallIDs.set(key, value.callID)
      } else partCallIDs.delete(key)
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
      partCallIDs.delete(key)
      truncatedParts.delete(key)
      deltaParts.delete(key)
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

  function replaceRequestStore(target: Map<string, number>, sessionID: string, value: unknown[] | undefined) {
    if (value === undefined || value.length === 0) {
      target.delete(sessionID)
      return
    }
    target.set(sessionID, serializedUtf8Bytes(value))
  }

  function removeParts(messageID: string) {
    const sessionID =
      [...parts].find(([key]) => key.startsWith(`${messageID}:`))?.[1].sessionID ?? pending.get(messageID)?.sessionID
    for (const [key, value] of parts) {
      if (!key.startsWith(`${messageID}:`)) continue
      adjust(value.sessionID, -value.bytes)
      parts.delete(key)
      partCallIDs.delete(key)
      truncatedParts.delete(key)
      deltaParts.delete(key)
    }
    const pendingValue = pending.get(messageID)
    if (pendingValue) {
      adjust(pendingValue.sessionID, -pendingValue.bytes)
      pending.delete(messageID)
    }
    partSessions.delete(messageID)
    if (sessionID !== undefined) refresh(sessionID)
  }

  function removeSession(sessionID: string, input: { readonly evicted?: boolean } = {}) {
    for (const [messageID, value] of messages) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      messages.delete(messageID)
      for (const key of [...truncatedParts]) if (key.startsWith(`${messageID}:`)) truncatedParts.delete(key)
      for (const key of [...deltaParts]) if (key.startsWith(`${messageID}:`)) deltaParts.delete(key)
    }
    for (const [key, value] of parts) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      parts.delete(key)
      partCallIDs.delete(key)
      truncatedParts.delete(key)
      deltaParts.delete(key)
    }
    for (const [messageID, value] of pending) {
      if (value.sessionID !== sessionID) continue
      adjust(sessionID, -value.bytes)
      pending.delete(messageID)
    }
    adjust(sessionID, -(todos.get(sessionID) ?? 0) + -(diffs.get(sessionID) ?? 0))
    todos.delete(sessionID)
    diffs.delete(sessionID)
    if (input.evicted !== true) {
      clearPermissionSession(sessionID)
      permissionStores.delete(sessionID)
      questionStores.delete(sessionID)
    }
    partSessions.forEach((value, key) => value === sessionID && partSessions.delete(key))
    sessions.delete(sessionID)
    resident.delete(sessionID)
    if (input.evicted === true) evictions++
    refresh(sessionID)
  }

  function replacePendingDelta(messageID: string, bytes: number) {
    const sessionID = partSessions.get(messageID) ?? pending.get(messageID)?.sessionID
    if (sessionID === undefined) return
    const previous = pending.get(messageID)
    const delta = bytes - (previous?.bytes ?? 0)
    if (previous) adjust(sessionID, -previous.bytes)
    if (bytes === 0) pending.delete(messageID)
    else {
      pending.set(messageID, { sessionID, bytes })
      adjust(sessionID, bytes)
    }
    if (options.isProtected?.(sessionID) === true) protectedResident += delta
    else evictableResident += delta
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
      partCallIDs.delete(key)
      truncatedParts.delete(key)
      deltaParts.delete(key)
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

  function clearDeltaParts(messageID: string, partID?: string) {
    if (partID !== undefined) {
      deltaParts.delete(`${messageID}:${partID}`)
      return
    }
    for (const key of [...deltaParts]) if (key.startsWith(`${messageID}:`)) deltaParts.delete(key)
  }

  function preparePart(sessionID: string, part: Part) {
    const key = `${part.messageID}:${part.id}`
    const scalarLimit = options.isActive?.(sessionID) === true ? activePartMaxBytes : partIngressBytes
    const measuredBytes = serializedUtf8Bytes(part)
    if (scalarLimit === 0) {
      clearTruncated(part.messageID, part.id)
      return { part, measuredBytes }
    }
    if (measuredBytes <= scalarLimit) {
      clearTruncated(part.messageID, part.id)
      return { part, measuredBytes }
    }
    let result = part
    let exceeded = false
    const scalar = (value: string) => {
      const bytes = serializedUtf8Bytes(value)
      if (bytes <= scalarLimit) return value
      exceeded = true
      markTruncated(key)
      return `[payload omitted by lowmem budget: ${bytes} bytes]`
    }
    switch (part.type) {
      case "text": {
        const text = scalar(part.text)
        if (exceeded) result = { ...part, text }
        break
      }
      case "reasoning": {
        const text = scalar(part.text)
        if (exceeded) result = { ...part, text }
        break
      }
      case "tool":
        if (part.state.status === "completed") {
          const output = scalar(part.state.output)
          if (exceeded) result = { ...part, state: { ...part.state, output } }
        } else clearTruncated(part.messageID, part.id)
        break
      case "file":
        if (part.source) {
          const value = scalar(part.source.text.value)
          if (exceeded) result = { ...part, source: { ...part.source, text: { ...part.source.text, value } } }
        } else clearTruncated(part.messageID, part.id)
        break
      case "agent":
        if (part.source) {
          const value = scalar(part.source.value)
          if (exceeded) result = { ...part, source: { ...part.source, value } }
        } else clearTruncated(part.messageID, part.id)
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
        return { part, measuredBytes }
    }
    if (!exceeded) {
      clearTruncated(part.messageID, part.id)
      return { part, measuredBytes }
    }
    return { part: result, measuredBytes: serializedUtf8Bytes(result) }
  }

  function preparePartAppend(sessionID: string, previousPart: AppendablePart, appendedText: string) {
    const part = { ...previousPart, text: previousPart.text + appendedText }
    const key = `${part.messageID}:${part.id}`
    const previous = parts.get(key)
    if (!previous || previous.sessionID !== sessionID || truncatedParts.has(key)) return preparePart(sessionID, part)
    const measuredBytes = previous.bytes + jsonStringAppendBytes(previousPart.text, appendedText)
    const scalarLimit = options.isActive?.(sessionID) === true ? activePartMaxBytes : partIngressBytes
    if (scalarLimit > 0 && measuredBytes > scalarLimit) return preparePart(sessionID, part)
    clearTruncated(part.messageID, part.id)
    return { part, measuredBytes }
  }

  function permissionKey(messageID: string, callID: string) {
    return `${messageID}:${callID}`
  }

  function setPermissionInput(
    sessionID: string,
    requestID: string,
    messageID: string,
    callID: string,
    value: Record<string, unknown>,
  ) {
    const key = permissionKey(messageID, callID)
    const requestKey = `${sessionID}:${requestID}`
    const previousKey = permissionRequests.get(requestKey)
    if (previousKey) clearPermissionKey(previousKey)
    clearPermissionKey(key)
    const bytes = serializedUtf8Bytes(value)
    const truncate =
      permissionAllowanceBytes > 0 &&
      (bytes > permissionAllowanceBytes || permissionBytes + bytes > permissionMapAllowanceBytes)
    const storedValue = truncate ? truncatePermissionInput(value, bytes) : value
    const storedBytes = serializedUtf8Bytes(storedValue)
    let overCount = permissionInputLimit > 0 && permissionInputs.size >= permissionInputLimit
    let overBytes = permissionMapAllowanceBytes > 0 && permissionBytes + storedBytes > permissionMapAllowanceBytes
    if (overCount || overBytes) {
      // Pressure evicts the oldest stored inputs from other sessions first;
      // the prompting session's entries are never dropped. When every entry
      // belongs to it, the new input is refused and the prompt renders its
      // truncation marker instead (see routes/session/permission.tsx).
      for (const [existingKey, entry] of permissionInputs) {
        if (!overCount && !overBytes) break
        if (entry.sessionID === sessionID) continue
        clearPermissionKey(existingKey)
        overCount = permissionInputLimit > 0 && permissionInputs.size >= permissionInputLimit
        overBytes = permissionMapAllowanceBytes > 0 && permissionBytes + storedBytes > permissionMapAllowanceBytes
      }
    }
    if (overCount || overBytes) {
      truncations++
      warnPressure(sessionID, true)
      refresh(sessionID)
      return
    }
    permissionInputs.set(key, { sessionID, requestKey, value: storedValue })
    permissionRequests.set(requestKey, key)
    const keys = sessionPermissionKeys.get(sessionID) ?? new Set<string>()
    keys.add(key)
    sessionPermissionKeys.set(sessionID, keys)
    permissionBytes += storedBytes
    if (truncate) {
      truncations++
      warnPressure(sessionID, true)
    }
    refresh(sessionID)
  }

  function clearPermissionKey(key: string) {
    const previous = permissionInputs.get(key)
    if (previous) {
      permissionBytes -= serializedUtf8Bytes(previous.value)
      permissionInputs.delete(key)
      sessionPermissionKeys.get(previous.sessionID)?.delete(key)
      if (permissionRequests.get(previous.requestKey) === key) permissionRequests.delete(previous.requestKey)
    }
  }

  function clearPermissionRequest(sessionID: string, requestID: string) {
    const requestKey = `${sessionID}:${requestID}`
    const key = permissionRequests.get(requestKey)
    if (key) clearPermissionKey(key)
    else permissionRequests.delete(requestKey)
    refresh(sessionID)
  }

  function clearPermissionForMessage(messageID: string) {
    for (const key of [...permissionInputs.keys()]) if (key.startsWith(`${messageID}:`)) clearPermissionKey(key)
  }

  function clearPermissionSession(sessionID: string) {
    for (const key of sessionPermissionKeys.get(sessionID) ?? []) clearPermissionKey(key)
    sessionPermissionKeys.delete(sessionID)
  }

  refresh()
  return {
    limits: {
      budgetBytes,
      sessionLimit,
      activeAllowanceBytes,
      activePartMaxBytes,
      permissionAllowanceBytes,
      permissionMapAllowanceBytes,
      permissionInputLimit,
      partIngressBytes,
    },
    replaceMessage,
    replacePart,
    replaceParts,
    replaceTodo: (sessionID: string, value: unknown[] | undefined) => replaceArray(todos, sessionID, value),
    replaceDiff: (sessionID: string, value: unknown[] | undefined) => replaceArray(diffs, sessionID, value),
    replaceSession,
    removeMessage: (sessionID: string, messageID: string) => {
      replaceMessage(sessionID, messageID, undefined)
      clearTruncated(messageID)
      clearDeltaParts(messageID)
      clearPermissionForMessage(messageID)
    },
    removePart: (messageID: string, partID: string) => {
      const key = `${messageID}:${partID}`
      const sessionID = parts.get(key)?.sessionID ?? partSessions.get(messageID)
      const callID = partCallIDs.get(key)
      if (sessionID) replacePart(messageID, partID, sessionID, undefined)
      clearTruncated(messageID, partID)
      clearDeltaParts(messageID, partID)
      if (callID !== undefined) clearPermissionKey(permissionKey(messageID, callID))
    },
    removeParts,
    removeSession,
    replacePendingDelta,
    preparePart,
    preparePartAppend,
    isTruncated: (messageID: string, partID: string) => truncatedParts.has(`${messageID}:${partID}`),
    markDeltaPart: (messageID: string, partID: string) => deltaParts.add(`${messageID}:${partID}`),
    hasDeltaPart: (messageID: string, partID: string) => deltaParts.has(`${messageID}:${partID}`),
    setPermissionInput,
    permissionInput: (messageID: string, callID: string) =>
      permissionInputs.get(permissionKey(messageID, callID))?.value,
    clearPermissionRequest,
    clearPermissionForMessage,
    clearPermissionSession,
    replacePermissionRequests: (sessionID: string, value: unknown[] | undefined) =>
      replaceRequestStore(permissionStores, sessionID, value),
    replaceQuestionRequests: (sessionID: string, value: unknown[] | undefined) =>
      replaceRequestStore(questionStores, sessionID, value),
    messageIDs: (sessionID: string) => {
      const result = new Set<string>()
      for (const [messageID, value] of messages) if (value.sessionID === sessionID) result.add(messageID)
      for (const [key, value] of parts) if (value.sessionID === sessionID) result.add(key.slice(0, key.indexOf(":")))
      for (const [messageID, value] of pending) if (value.sessionID === sessionID) result.add(messageID)
      return [...result]
    },
    sessionIDs: () => [...sessions],
    sessionBytes: (sessionID: string) => resident.get(sessionID) ?? 0,
    refresh,
    overLimit: () =>
      (budgetBytes > 0 && evictableResident > budgetBytes) ||
      (sessionLimit > 0 && evictableSessionCount > sessionLimit),
    warnPressure,
    stats: (): PayloadBudgetStats => ({
      evictableResident,
      protectedResident,
      evictableSessionCount,
      protectedSessionCount,
      count: sessions.size,
      evictions,
      truncations,
      permissionBytes,
      permissionCount: permissionInputs.size,
      permissionStoreBytes: [...permissionStores.values()].reduce((total, bytes) => total + bytes, 0),
      questionStoreBytes: [...questionStores.values()].reduce((total, bytes) => total + bytes, 0),
    }),
  }
}
