import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { MemoryStat } from "../../src/cli/memory-stat"

function harness(directory: string) {
  let timestamp = 1_000
  let callback: (() => Promise<void>) | undefined
  let stopped = false
  let schedules = 0
  const runtime = {
    memoryUsage: () => ({ rss: 10, heapTotal: 20, heapUsed: 30, external: 40, arrayBuffers: 50 }),
    heapStats: () => ({ heapSize: 60, heapCapacity: 70, extraMemorySize: 80, objectCount: 90 }),
    now: () => timestamp++,
    pid: () => 101,
    schedule: (next: () => Promise<void>) => {
      schedules++
      callback = next
      return {
        stop: () => {
          stopped = true
        },
      }
    },
  }
  const recorder = MemoryStat.create({ directory, role: "tui", runtime })

  return {
    recorder,
    runtime,
    async tick() {
      if (stopped || !callback) return
      await callback()
    },
    get stopped() {
      return stopped
    },
    get schedules() {
      return schedules
    },
  }
}

describe("memory stat", () => {
  test("keeps at most sixty samples when repeatedly sampled", async () => {
    await using tmp = await tmpdir()
    const diagnostics = harness(tmp.path)

    await diagnostics.recorder.start()
    for (let index = 0; index < 70; index++) await diagnostics.tick()

    const artifact = await Bun.file(path.join(tmp.path, "tui.memory.json")).json()
    expect(artifact.samples).toHaveLength(60)
    expect(artifact.samples[0].time).toBe(1_011)
    expect(artifact.samples.at(-1).time).toBe(1_070)
  })

  test("does not schedule or write when the opt-in path is absent", async () => {
    await using tmp = await tmpdir()
    const previous = process.env.OPENCODE_MEMORY_STATS_PATH
    delete process.env.OPENCODE_MEMORY_STATS_PATH

    try {
      const diagnostics = harness(tmp.path)
      const recorder = await MemoryStat.start({ role: "tui", runtime: diagnostics.runtime })

      expect(recorder).toBeUndefined()
      expect(diagnostics.schedules).toBe(0)
      expect(await Bun.file(path.join(tmp.path, "tui.memory.json")).exists()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_STATS_PATH
      else process.env.OPENCODE_MEMORY_STATS_PATH = previous
    }
  })

  test("writes private numeric samples by atomically replacing the role artifact", async () => {
    await using tmp = await tmpdir()
    const diagnostics = harness(tmp.path)

    await diagnostics.recorder.start()
    const first = await Bun.file(path.join(tmp.path, "tui.memory.json")).text()
    await diagnostics.tick()
    const artifact = await Bun.file(path.join(tmp.path, "tui.memory.json")).json()

    expect(first).not.toBe(JSON.stringify(artifact))
    expect(Object.keys(artifact)).toEqual(["samples"])
    expect(artifact.samples).toEqual([
      {
        role: "tui",
        pid: 101,
        time: 1_000,
        rss: 10,
        heapTotal: 20,
        heapUsed: 30,
        external: 40,
        arrayBuffers: 50,
        heapSize: 60,
        heapCapacity: 70,
        extraMemorySize: 80,
        objectCount: 90,
      },
      {
        role: "tui",
        pid: 101,
        time: 1_001,
        rss: 10,
        heapTotal: 20,
        heapUsed: 30,
        external: 40,
        arrayBuffers: 50,
        heapSize: 60,
        heapCapacity: 70,
        extraMemorySize: 80,
        objectCount: 90,
      },
    ])
    expect((await Array.fromAsync(new Bun.Glob("*").scan(tmp.path))).sort()).toEqual(["tui.memory.json"])
  })

  test("stops the sampler during lifecycle teardown", async () => {
    await using tmp = await tmpdir()
    const diagnostics = harness(tmp.path)

    await diagnostics.recorder.start()
    await diagnostics.recorder.stop()
    await diagnostics.tick()

    const artifact = await Bun.file(path.join(tmp.path, "tui.memory.json")).json()
    expect(diagnostics.stopped).toBe(true)
    expect(artifact.samples).toHaveLength(1)
  })

  test("does not overlap writes and waits for the active write during teardown", async () => {
    // given
    await using tmp = await tmpdir()
    const diagnostics = harness(tmp.path)
    await diagnostics.recorder.start()

    const original = Bun.write
    const writeStarted = Promise.withResolvers<void>()
    const writeRelease = Promise.withResolvers<void>()
    const write = spyOn(Bun, "write").mockImplementation(async (destination, data) => {
      if (typeof destination !== "string") throw new Error("expected a string write destination")
      if (typeof data !== "string") throw new Error("expected a JSON string sample")
      writeStarted.resolve()
      await writeRelease.promise
      return original(destination, data)
    })

    // when
    const first = diagnostics.tick()
    await writeStarted.promise
    const second = diagnostics.tick()
    let stopped = false
    const stop = Promise.resolve(diagnostics.recorder.stop()).then(() => {
      stopped = true
    })

    try {
      // then
      await Promise.resolve()
      expect(write).toHaveBeenCalledTimes(1)
      expect(stopped).toBe(false)
    } finally {
      writeRelease.resolve()
      await Promise.all([first, second, stop])
      write.mockRestore()
    }
  })

  test("logs once and stops sampling after a scheduled write failure", async () => {
    // given
    await using tmp = await tmpdir()
    const diagnostics = harness(tmp.path)
    await diagnostics.recorder.start()
    await mkdir(path.join(tmp.path, "tui.memory.json.tmp-101"))
    const error = spyOn(console, "error").mockImplementation(() => {})

    try {
      // when
      await Promise.all([diagnostics.tick(), diagnostics.tick()])

      // then
      expect(diagnostics.stopped).toBe(true)
      expect(error).toHaveBeenCalledTimes(1)

      await rm(path.join(tmp.path, "tui.memory.json.tmp-101"), { recursive: true })
      await diagnostics.tick()

      const artifact = await Bun.file(path.join(tmp.path, "tui.memory.json")).json()
      expect(artifact.samples).toHaveLength(1)
    } finally {
      await diagnostics.recorder.stop()
      error.mockRestore()
    }
  })

  test("fails before scheduling when the configured directory is not writable", async () => {
    // given
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "not-a-directory")
    await Bun.write(directory, "blocked")
    const diagnostics = harness(directory)

    // when
    const start = diagnostics.recorder.start()

    // then
    await expect(start).rejects.toThrow()
    expect(diagnostics.schedules).toBe(0)
  })

  test("writes a real runtime artifact", async () => {
    // given
    await using tmp = await tmpdir()
    const recorder = MemoryStat.create({ directory: tmp.path, role: "server" })

    try {
      // when
      await recorder.start()
      const artifact = await Bun.file(path.join(tmp.path, "server.memory.json")).json()

      // then
      expect(artifact.samples).toHaveLength(1)
      expect(artifact.samples[0].role).toBe("server")
      expect(Number.isFinite(artifact.samples[0].rss)).toBe(true)
      expect(Number.isFinite(artifact.samples[0].heapSize)).toBe(true)
    } finally {
      await recorder.stop()
    }
  })
})
