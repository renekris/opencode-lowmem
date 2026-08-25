import { readEnvLimit } from "../util/env-limit"

export type PartDeltaEntry = { messageID: string; partID: string; field: string; accumulated: string }

type PendingEntry = { messageID: string; partID: string; field: string; chunks: string[]; bytes: number }
type FlushedPart = { messageID: string; partID: string }

type DeltaBufferOptions = {
  readonly intervalMs?: number
  readonly maxBytes?: number
  readonly maxEntries?: number
  readonly apply: (entry: PartDeltaEntry) => void
  readonly onPendingBytes?: (messageID: string, bytes: number) => void
  readonly warn?: (fields: Record<string, unknown>) => void
}

const encoder = new TextEncoder()
const WARNING_INTERVAL = 60_000

export function createPartDeltaBuffer(options: DeltaBufferOptions) {
  const intervalMs = options.intervalMs ?? 120
  const maxBytes = options.maxBytes ?? readEnvLimit("OPENCODE_TUI_DELTA_BUFFER_MAX_KB", "4096KB")
  const maxEntries = options.maxEntries ?? readEnvLimit("OPENCODE_TUI_DELTA_BUFFER_MAX_ENTRIES", "512", "count")
  const pending = new Map<string, PendingEntry>()
  const warn = options.warn ?? ((fields: Record<string, unknown>) => console.warn("tui part delta buffer pressure", fields))
  let timer: ReturnType<typeof setTimeout> | undefined
  let bytes = 0
  let lastWarning = 0
  let pressureFlushes = 0

  function pendingBytesForMessage(messageID: string) {
    let total = 0
    for (const entry of pending.values()) if (entry.messageID === messageID) total += entry.bytes
    return total
  }

  function notify(entry: PendingEntry, nextBytes: number) {
    bytes += nextBytes - entry.bytes
    entry.bytes = nextBytes
    options.onPendingBytes?.(entry.messageID, pendingBytesForMessage(entry.messageID))
  }

  function flushEntry(key: string): FlushedPart | undefined {
    const entry = pending.get(key)
    if (!entry) return undefined
    pending.delete(key)
    notify(entry, 0)
    options.apply({
      messageID: entry.messageID,
      partID: entry.partID,
      field: entry.field,
      accumulated: entry.chunks.join(""),
    })
    return { messageID: entry.messageID, partID: entry.partID }
  }

  function discardEntry(key: string) {
    const entry = pending.get(key)
    if (!entry) return
    pending.delete(key)
    notify(entry, 0)
  }

  function flush() {
    timer = undefined
    for (const key of [...pending.keys()]) flushEntry(key)
  }

  function flushOverflow() {
    while (true) {
      const overBytes = maxBytes > 0 && bytes > maxBytes
      const overEntries = maxEntries > 0 && pending.size > maxEntries
      if (!overBytes && !overEntries) return
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      const entry = pending.get(oldest)
      if (!entry) break
      const now = Date.now()
      if (now - lastWarning >= WARNING_INTERVAL) {
        lastWarning = now
        warn({
          component: "tui.part-delta-buffer",
          budget: "OPENCODE_TUI_DELTA_BUFFER_MAX_KB",
          countBudget: "OPENCODE_TUI_DELTA_BUFFER_MAX_ENTRIES",
          evictableResident: bytes,
          protectedResident: 0,
          count: pending.size,
          evictions: pressureFlushes + 1,
          truncations: 0,
          messageID: entry.messageID,
          partID: entry.partID,
          pressure: overBytes && overEntries ? "bytes-and-count" : overBytes ? "bytes" : "count",
          action: "flush-oldest-entry",
        })
      }
      flushEntry(oldest)
      pressureFlushes += 1
    }
  }

  return {
    push(input: { messageID: string; partID: string; field: string; delta: string }) {
      const key = `${input.messageID}:${input.partID}:${input.field}`
      const existing = pending.get(key)
      const deltaBytes = encoder.encode(input.delta).byteLength
      if (existing) {
        existing.chunks.push(input.delta)
        notify(existing, existing.bytes + deltaBytes)
      } else {
        const entry = {
          messageID: input.messageID,
          partID: input.partID,
          field: input.field,
          chunks: [input.delta],
          bytes: 0,
        }
        pending.set(key, entry)
        notify(entry, deltaBytes)
      }
      if (timer === undefined) timer = setTimeout(flush, intervalMs)
      flushOverflow()
    },
    dropMessage(messageID: string) {
      for (const key of [...pending.keys()]) if (key.startsWith(`${messageID}:`)) discardEntry(key)
      if (pending.size === 0 && timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
    flushMessages(messageIDs: readonly string[]) {
      const selected = new Set(messageIDs)
      const flushed: FlushedPart[] = []
      for (const [key, entry] of pending) {
        if (!selected.has(entry.messageID)) continue
        const result = flushEntry(key)
        if (result) flushed.push(result)
      }
      if (pending.size === 0 && timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      return flushed
    },
    flushNow() {
      if (timer !== undefined) {
        clearTimeout(timer)
        flush()
      }
    },
    pendingCount() {
      return pending.size
    },
    pendingBytes() {
      return bytes
    },
  }
}
