import { describe, expect, test } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber } from "effect"
import vectors from "./env-limit-vectors.json" with { type: "json" }
import { it } from "./lib/effect"
import { EnvLimit } from "../src/util/env-limit"

function setEnvironment(name: string, value: string) {
  const previous = process.env[name]
  process.env[name] = value
  return () => {
    if (previous === undefined) {
      delete process.env[name]
      return
    }
    process.env[name] = previous
  }
}

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob environment limits", () => {
  test("matches the core count and byte vectors", () => {
    for (const vector of vectors.bytes) {
      expect(EnvLimit.parseEnvLimit(vector.input, "64MB", "bytes")).toBe(vector.expected)
    }
    for (const vector of vectors.counts) {
      expect(EnvLimit.parseEnvLimit(vector.input, "128", "count")).toBe(vector.expected)
    }
    for (const input of vectors.invalidBytes) {
      expect(() => EnvLimit.parseEnvLimit(input, "64MB", "bytes")).toThrow()
    }
    for (const input of vectors.invalidCounts) {
      expect(() => EnvLimit.parseEnvLimit(input, "128", "count")).toThrow()
    }
  })
})

describe("BackgroundJob settled entries", () => {
  it.live("notifies a promotion waiter before stripping and removing its terminal record", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "2")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "1KB")
      try {
        const jobs = yield* BackgroundJob.make
        const latch = yield* Deferred.make<void>()
        const first = yield* jobs.start({
          id: "settled-first",
          type: "test",
          run: Deferred.await(latch).pipe(Effect.as("first")),
        })
        const promotion = yield* jobs.waitForPromotion(first.id).pipe(Effect.forkChild)

        yield* Deferred.succeed(latch, undefined)
        const promoted = yield* Fiber.join(promotion)

        expect(promoted).toMatchObject({ id: first.id, status: "completed", output: "first" })

        const second = yield* jobs.start({
          id: "settled-second",
          type: "test",
          run: Effect.succeed("s".repeat(700)),
        })
        yield* jobs.wait({ id: second.id })
        const third = yield* jobs.start({
          id: "settled-third",
          type: "test",
          run: Effect.succeed("t".repeat(700)),
        })
        yield* jobs.wait({ id: third.id })

        expect((yield* jobs.wait({ id: second.id })).info?.output).toBeUndefined()
        expect((yield* jobs.wait({ id: second.id })).status).toBe("available")

        const fourth = yield* jobs.start({
          id: "settled-fourth",
          type: "test",
          run: Effect.succeed("fourth"),
        })
        yield* jobs.wait({ id: fourth.id })

        expect(yield* jobs.wait({ id: second.id })).toEqual({ status: "expired", timedOut: false })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )

  it.live("returns terminal metadata directly to a late promotion caller", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.succeed("done") })

      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        status: "available",
        info: { status: "completed", output: "done" },
      })
      expect(yield* jobs.waitForPromotion(job.id)).toMatchObject({ status: "completed", output: "done" })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("releases an already waiting promotion caller when settlement wins the promotion race", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs.waitForPromotion(job.id).pipe(Effect.forkChild)

      const [promotionResult] = yield* Effect.all(
        [jobs.promote(job.id), Deferred.succeed(latch, undefined)],
        { concurrency: "unbounded" },
      )

      const promoted = yield* Fiber.join(waiting)
      if (!promoted) throw new Error("promotion waiter expired during settlement race")
      expect(promoted.id).toBe(job.id)
      expect(["running", "completed"]).toContain(promoted.status)
      expect(promotionResult === undefined || promoted.status === "running").toBe(true)
      if (promoted.status === "completed") expect(promoted.output).toBe("done")
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("resolves promotion waiters before converting a cancelled job to terminal metadata", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.never })
      const waiting = yield* jobs.waitForPromotion(job.id).pipe(Effect.forkChild)

      yield* jobs.cancel(job.id)

      expect(yield* Fiber.join(waiting)).toMatchObject({ id: job.id, status: "cancelled" })
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        status: "available",
        info: { id: job.id, status: "cancelled" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("bounds terminal records and retained output bytes with observable counters", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "2")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "1KB")
      try {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({ id: "ring-first", type: "test", run: Effect.succeed("a".repeat(700)) })
        yield* jobs.wait({ id: first.id })
        const second = yield* jobs.start({ id: "ring-second", type: "test", run: Effect.succeed("b".repeat(700)) })
        yield* jobs.wait({ id: second.id })
        const third = yield* jobs.start({ id: "ring-third", type: "test", run: Effect.succeed("c".repeat(700)) })
        yield* jobs.wait({ id: third.id })

        expect((yield* jobs.list()).map((info) => info.id)).toEqual(["ring-second", "ring-third"])
        expect((yield* jobs.wait({ id: first.id })).status).toBe("expired")
        expect((yield* jobs.wait({ id: second.id })).info?.output).toBeUndefined()
        expect((yield* jobs.wait({ id: third.id })).info?.output).toBe("c".repeat(700))

        const inspection = yield* jobs.inspect()
        expect(inspection.settledCount).toBe(2)
        expect(inspection.settledOutputBytes).toBe(700)
        expect(inspection.evictions).toBe(1)
        expect(inspection.outputStrips).toBe(2)
        expect(inspection.waiters).toBe(0)
        expect(inspection.settledResources).toEqual({ deferreds: 0, scopes: 0, tokens: 0 })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )

  it.live("strips oldest output before evicting oldest terminal records", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "3")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "1KB")
      try {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({ id: "ordered-first", type: "test", run: Effect.succeed("a".repeat(700)) })
        yield* jobs.wait({ id: first.id })
        const second = yield* jobs.start({ id: "ordered-second", type: "test", run: Effect.succeed("b".repeat(700)) })
        yield* jobs.wait({ id: second.id })

        expect((yield* jobs.list()).map((info) => info.id)).toEqual([first.id, second.id])
        expect((yield* jobs.wait({ id: first.id })).info?.output).toBeUndefined()
        expect((yield* jobs.wait({ id: second.id })).info?.output).toBe("b".repeat(700))
        expect(yield* jobs.inspect()).toMatchObject({
          settledCount: 2,
          settledOutputBytes: 700,
          evictions: 0,
          outputStrips: 1,
        })

        const third = yield* jobs.start({ id: "ordered-third", type: "test", run: Effect.succeed("c".repeat(700)) })
        yield* jobs.wait({ id: third.id })
        const fourth = yield* jobs.start({ id: "ordered-fourth", type: "test", run: Effect.succeed("d".repeat(700)) })
        yield* jobs.wait({ id: fourth.id })

        expect((yield* jobs.wait({ id: first.id })).status).toBe("expired")
        expect((yield* jobs.list()).map((info) => info.id)).toEqual([second.id, third.id, fourth.id])
        expect((yield* jobs.wait({ id: second.id })).info?.output).toBeUndefined()
        expect((yield* jobs.wait({ id: third.id })).info?.output).toBeUndefined()
        expect((yield* jobs.wait({ id: fourth.id })).info?.output).toBe("d".repeat(700))
        expect(yield* jobs.inspect()).toMatchObject({
          settledCount: 3,
          settledOutputBytes: 700,
          evictions: 1,
          outputStrips: 3,
        })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )

  it.live("treats exact zero as disabling both settled ring limits", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "0")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "0")
      try {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({ id: "unlimited-first", type: "test", run: Effect.succeed("a".repeat(700)) })
        yield* jobs.wait({ id: first.id })
        const second = yield* jobs.start({ id: "unlimited-second", type: "test", run: Effect.succeed("b".repeat(700)) })
        yield* jobs.wait({ id: second.id })

        expect((yield* jobs.list()).map((info) => info.id)).toEqual([first.id, second.id])
        expect(yield* jobs.inspect()).toMatchObject({
          settledCount: 2,
          settledOutputBytes: 1400,
          evictions: 0,
          outputStrips: 0,
        })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )

  it.live("strips output before count eviction when both limits are exceeded", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "2")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "1MB")
      try {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({
          id: "simultaneous-first",
          type: "test",
          run: Effect.succeed("a".repeat(400 * 1024)),
        })
        yield* jobs.wait({ id: first.id })
        const second = yield* jobs.start({
          id: "simultaneous-second",
          type: "test",
          run: Effect.succeed("b".repeat(400 * 1024)),
        })
        yield* jobs.wait({ id: second.id })
        const third = yield* jobs.start({
          id: "simultaneous-third",
          type: "test",
          run: Effect.succeed("c".repeat(400 * 1024)),
        })
        yield* jobs.wait({ id: third.id })

        expect((yield* jobs.wait({ id: first.id })).status).toBe("expired")
        expect((yield* jobs.wait({ id: second.id })).info?.output).toBe("b".repeat(400 * 1024))
        expect((yield* jobs.wait({ id: third.id })).info?.output).toBe("c".repeat(400 * 1024))
        expect(yield* jobs.inspect()).toMatchObject({
          settledCount: 2,
          settledOutputBytes: 800 * 1024,
          evictions: 1,
          outputStrips: 1,
        })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )

  it.live("count pressure alone removes the oldest terminal record without stripping", () =>
    Effect.gen(function* () {
      const restoreCount = setEnvironment("OPENCODE_BGJOB_SETTLED_MAX", "2")
      const restoreBytes = setEnvironment("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", "0")
      try {
        const jobs = yield* BackgroundJob.make
        const first = yield* jobs.start({ id: "count-only-first", type: "test", run: Effect.succeed("a".repeat(700)) })
        yield* jobs.wait({ id: first.id })
        const second = yield* jobs.start({ id: "count-only-second", type: "test", run: Effect.succeed("b".repeat(700)) })
        yield* jobs.wait({ id: second.id })
        const third = yield* jobs.start({ id: "count-only-third", type: "test", run: Effect.succeed("c".repeat(700)) })
        yield* jobs.wait({ id: third.id })

        expect((yield* jobs.wait({ id: first.id })).status).toBe("expired")
        expect((yield* jobs.list()).map((info) => info.id)).toEqual(["count-only-second", "count-only-third"])
        expect((yield* jobs.wait({ id: second.id })).info?.output).toBe("b".repeat(700))
        expect((yield* jobs.wait({ id: third.id })).info?.output).toBe("c".repeat(700))
        expect(yield* jobs.inspect()).toMatchObject({
          settledCount: 2,
          settledOutputBytes: 1400,
          evictions: 1,
          outputStrips: 0,
        })
      } finally {
        restoreBytes()
        restoreCount()
      }
    }),
  )
})
