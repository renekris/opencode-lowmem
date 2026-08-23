// Fork(lowmem): TUI-side port of the #42150 pattern. Appending every stream
// delta directly into the Solid store does O(n²) string churn per response for
// every hosted session (background subagents included); buffering deltas and
// writing once per interval keeps reactive updates and allocations linear.
export type PartDeltaEntry = { messageID: string; partID: string; field: string; accumulated: string }

type PendingEntry = { messageID: string; partID: string; field: string; chunks: string[] }

export function createPartDeltaBuffer(options: { intervalMs?: number; apply: (entry: PartDeltaEntry) => void }) {
  const intervalMs = options.intervalMs ?? 120
  const pending = new Map<string, PendingEntry>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    timer = undefined
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      // Join once per flush: chunk arrays keep bursts linear; += per push would be quadratic.
      options.apply({
        messageID: entry.messageID,
        partID: entry.partID,
        field: entry.field,
        accumulated: entry.chunks.join(""),
      })
    }
  }

  return {
    push(input: { messageID: string; partID: string; field: string; delta: string }) {
      const key = `${input.messageID}:${input.partID}:${input.field}`
      const existing = pending.get(key)
      if (existing) existing.chunks.push(input.delta)
      else
        pending.set(key, {
          messageID: input.messageID,
          partID: input.partID,
          field: input.field,
          chunks: [input.delta],
        })
      if (timer === undefined) timer = setTimeout(flush, intervalMs)
    },
    dropMessage(messageID: string) {
      for (const key of pending.keys()) {
        if (key.startsWith(`${messageID}:`)) pending.delete(key)
      }
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
  }
}
