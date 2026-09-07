import { mkdir, rename } from "node:fs/promises"
import path from "path"
import { heapStats } from "bun:jsc"
import { Flag } from "@opencode-ai/core/flag/flag"

const INTERVAL = 60_000
export const CAPACITY = 60

export type Role = "tui" | "server"

type Sample = {
  readonly role: Role
  readonly pid: number
  readonly time: number
  readonly rss: number
  readonly heapTotal: number
  readonly heapUsed: number
  readonly external: number
  readonly arrayBuffers: number
  readonly heapSize: number
  readonly heapCapacity: number
  readonly extraMemorySize: number
  readonly objectCount: number
}

type Runtime = {
  readonly memoryUsage: () => ReturnType<typeof process.memoryUsage>
  readonly heapStats: () => Pick<
    ReturnType<typeof heapStats>,
    "heapSize" | "heapCapacity" | "extraMemorySize" | "objectCount"
  >
  readonly now: () => number
  readonly pid: () => number
  readonly schedule: (callback: () => Promise<void>) => { readonly stop: () => void }
}

const runtime = {
  memoryUsage: () => process.memoryUsage(),
  heapStats,
  now: Date.now,
  pid: () => process.pid,
  schedule: (callback: () => Promise<void>) => {
    const timer = setInterval(() => {
      void callback()
    }, INTERVAL)
    timer.unref?.()
    return { stop: () => clearInterval(timer) }
  },
} satisfies Runtime

export function create(input: { readonly directory: string; readonly role: Role; readonly runtime?: Runtime }) {
  const source = input.runtime ?? runtime
  const samples: Sample[] = []
  const artifact = path.join(input.directory, `${input.role}.memory.json`)
  const temporary = artifact + `.tmp-${source.pid()}`
  let timer: { readonly stop: () => void } | undefined
  let pending: Promise<void> | undefined
  let stopped = false
  let failed = false

  // RSS is process-wide: TUI and server Worker samples can share it, so do not add their RSS values.
  const sample = async () => {
    if (pending || stopped || failed) return
    const next = (async () => {
      const memory = source.memoryUsage()
      const heap = source.heapStats()
      samples.push({
        role: input.role,
        pid: source.pid(),
        time: source.now(),
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        heapSize: heap.heapSize,
        heapCapacity: heap.heapCapacity,
        extraMemorySize: heap.extraMemorySize,
        objectCount: heap.objectCount,
      })
      if (samples.length > CAPACITY) samples.shift()
      await Bun.write(temporary, JSON.stringify({ samples }))
      await rename(temporary, artifact)
    })()
    pending = next
    try {
      await next
    } finally {
      if (pending === next) pending = undefined
    }
  }

  return {
    async start() {
      await mkdir(input.directory, { recursive: true })
      await sample()
      timer = source.schedule(async () => {
        try {
          await sample()
        } catch (error) {
          failed = true
          timer?.stop()
          console.error(
            `Memory telemetry sampling stopped after failing to write ${artifact}. Set OPENCODE_MEMORY_STATS_PATH to a writable directory: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    },
    async stop() {
      stopped = true
      timer?.stop()
      const current = pending
      if (current) await Promise.allSettled([current])
    },
  }
}

export async function start(input: { readonly role: Role; readonly runtime?: Runtime }) {
  const directory = Flag.OPENCODE_MEMORY_STATS_PATH
  if (!directory) return
  const recorder = create({ directory, role: input.role, runtime: input.runtime })
  await recorder.start()
  return recorder
}

export * as MemoryStat from "./memory-stat"
