import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer } from "effect"
import path from "path"
import { Snapshot } from "../../src/snapshot"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(Snapshot.node)))

describe("snapshot diff payload limits", () => {
  it.instance(
    "omits huge patches from durable diff summaries",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const beforePath = path.join(tmp.directory, "big.txt")
        yield* Effect.promise(() => Bun.write(beforePath, "before\n"))
        const from = yield* snapshot.track()
        expect(from).toBeTruthy()

        const largeText = Array.from({ length: 4_500 }, (_, index) => `line ${index}`).join("\n")
        yield* Effect.promise(() => Bun.write(beforePath, `${largeText}\n`))
        const to = yield* snapshot.track()
        expect(to).toBeTruthy()

        const diffs = yield* snapshot.diffFull(from!, to!)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.file).toBe("big.txt")
        expect(diffs[0]?.patch).toBe("[opencode: patch omitted (changed lines exceed 4000)]")
      }),
    { git: true },
  )

  it.instance(
    "omits large single-line blobs before loading file contents",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const file = path.join(tmp.directory, "large.json")
        yield* Effect.promise(() => Bun.write(file, "{}\n"))
        const from = yield* snapshot.track()
        yield* Effect.promise(() => Bun.write(file, `{"data":"${"x".repeat(1_100_000)}"}\n`))
        const to = yield* snapshot.track()

        const diffs = yield* snapshot.diffFull(from!, to!)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.patch).toBe("[opencode: patch omitted (blob exceeds 1000000 bytes)]")
      }),
    { git: true },
  )

  it.instance(
    "omits generated path patches before loading file contents",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const file = path.join(tmp.directory, "dist", "bundle.js")
        yield* Effect.promise(() => Bun.write(file, "old\n"))
        const from = yield* snapshot.track()
        yield* Effect.promise(() => Bun.write(file, "new\n"))
        const to = yield* snapshot.track()

        const diffs = yield* snapshot.diffFull(from!, to!)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.patch).toBe("[opencode: patch omitted (generated path)]")
      }),
    { git: true },
  )

  it.instance(
    "caps aggregate stored patch bytes across very large diff summaries",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const files = Array.from({ length: 12 }, (_, index) => path.join(tmp.directory, `large-${index}.txt`))
        for (const file of files) {
          yield* Effect.promise(() => Bun.write(file, "before\n"))
        }
        const from = yield* snapshot.track()
        for (const [index, file] of files.entries()) {
          yield* Effect.promise(() => Bun.write(file, `${"x".repeat(900_000)}-${index}\n`))
        }
        const to = yield* snapshot.track()

        const diffs = yield* snapshot.diffFull(from!, to!)
        expect(diffs).toHaveLength(12)
        expect(diffs.some((item) => item.patch?.includes("diff patches exceed 10485760 bytes"))).toBe(true)
        expect(Buffer.byteLength(diffs.map((item) => item.patch).join(""), "utf8")).toBeLessThan(11_000_000)
      }),
    { git: true },
  )

  it.instance(
    "keeps small patches intact",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const snapshot = yield* Snapshot.Service
        const file = path.join(tmp.directory, "small.txt")
        yield* Effect.promise(() => Bun.write(file, "before\n"))
        const from = yield* snapshot.track()
        yield* Effect.promise(() => Bun.write(file, "after\n"))
        const to = yield* snapshot.track()

        const diffs = yield* snapshot.diffFull(from!, to!)
        expect(diffs).toHaveLength(1)
        expect(diffs[0]?.patch).toContain("-before")
        expect(diffs[0]?.patch).toContain("+after")
      }),
    { git: true },
  )
})
