import { describe, expect, test } from "bun:test"
import vectors from "./env-limit-vectors.json" with { type: "json" }
import { DocumentStore } from "@/lsp/document-store"
import { EnvLimit } from "@/util/env-limit"

describe("environment limit parser", () => {
  test("matches the shared count and byte vectors", () => {
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

describe("DocumentStore", () => {
  test("evicts least-recently-used documents until count and bytes fit", async () => {
    const store = DocumentStore.create({
      documentLimit: 2,
      documentMaxBytes: 10,
      documentOpenAllowanceBytes: 0,
    })
    const evicted: string[] = []
    store.onEvict(({ path }) => {
      evicted.push(path)
    })

    await store.open("/tmp/a.ts", "12345")
    await store.open("/tmp/b.ts", "12345")
    expect(store.stats()).toMatchObject({ count: 2, bytes: 10 })

    const leastRecentlyUsed = store.get("/tmp/a.ts")
    expect(leastRecentlyUsed?.metadataOnly).toBe(false)
    if (leastRecentlyUsed?.metadataOnly === false) expect(leastRecentlyUsed.text).toBe("12345")
    await store.open("/tmp/c.ts", "12345")

    expect(evicted).toEqual(["/tmp/b.ts"])
    expect(store.stats()).toMatchObject({ count: 2, bytes: 10 })
    expect(store.has("/tmp/a.ts")).toBe(true)
    expect(store.has("/tmp/b.ts")).toBe(false)
    expect(store.has("/tmp/c.ts")).toBe(true)
  })

  test("refreshing an open document updates its recency", async () => {
    const store = DocumentStore.create({
      documentLimit: 2,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    })
    const evicted: string[] = []
    store.onEvict(({ path }) => {
      evicted.push(path)
    })

    await store.open("/tmp/a.ts", "a")
    await store.open("/tmp/b.ts", "b")
    const refreshed = await store.open("/tmp/a.ts", "a refreshed")
    await store.open("/tmp/c.ts", "c")

    expect(refreshed).toMatchObject({ version: 1, text: "a refreshed", metadataOnly: false })
    expect(evicted).toEqual(["/tmp/b.ts"])
    expect(store.has("/tmp/a.ts")).toBe(true)
    expect(store.has("/tmp/b.ts")).toBe(false)
  })

  test("warns once for repeated eviction pressure within the rate window", async () => {
    const warnings: { message: string; data: unknown }[] = []
    const store = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
      warn: (message, data) => warnings.push({ message, data }),
    })

    await store.open("/tmp/a.ts", "a")
    await store.open("/tmp/b.ts", "b")
    await store.open("/tmp/c.ts", "c")

    expect(store.generation).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      message: "lsp document store pressure",
      data: {
        component: "opencode.lsp.document-store",
        budget: "OPENCODE_LSP_DOC_LIMIT / OPENCODE_LSP_DOC_MAX_MB",
        count: 0,
        bytes: 0,
        action: "evict",
        documentPath: "/tmp/a.ts",
      },
    })
  })

  test("retains oversized documents as metadata and closes before refresh reopen", async () => {
    const store = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 64,
      documentOpenAllowanceBytes: 4,
    })
    const events: string[] = []
    store.onEvict(async ({ path }) => {
      events.push(`close:${path}`)
      await Promise.resolve()
      events.push(`closed:${path}`)
    })

    const first = await store.open("/tmp/large.ts", "123456", async (event) => {
      events.push(`${event.kind}:${event.document.version}:${event.text}`)
    })
    expect(first).toMatchObject({ version: 0, byteLength: 6, metadataOnly: true })
    expect(first.metadataOnly).toBe(true)
    expect(store.stats()).toMatchObject({ count: 0, bytes: 0, metadataOnly: 1 })

    expect(await store.touch("/tmp/large.ts")).toBeUndefined()
    const reopened = await store.open("/tmp/large.ts", "ok", async (event) => {
      events.push(`${event.kind}:${event.document.version}:${event.text}`)
    })

    expect(reopened).toMatchObject({ version: 0, text: "ok", metadataOnly: false })
    expect(events).toEqual([
      "open:0:123456",
      "close:/tmp/large.ts",
      "closed:/tmp/large.ts",
      "open:0:ok",
    ])
  })

  test("does not count the document while its open notification is in flight", async () => {
    const store = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    })
    await store.open("/tmp/a.ts", "a")

    let release = () => {}
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    let snapshot = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    }).stats()

    const opening = store.open("/tmp/b.ts", "b", async (event) => {
      snapshot = store.stats()
      entered()
      await releasePromise
      expect(event.kind).toBe("open")
    })
    await enteredPromise

    expect(snapshot).toMatchObject({ count: 0, bytes: 0, openingCount: 1, openingBytes: 1 })
    release()
    await opening
    expect(store.stats()).toMatchObject({ count: 1, bytes: 1, openingCount: 0 })
  })

  test("serializes concurrent opens across different paths", async () => {
    const store = DocumentStore.create({
      documentLimit: 2,
      documentMaxBytes: 2,
      documentOpenAllowanceBytes: 0,
    })
    const paths = ["/tmp/a.ts", "/tmp/b.ts", "/tmp/c.ts", "/tmp/d.ts", "/tmp/e.ts"]
    const enteredResolvers: Array<() => void> = []
    const entered = paths.map(
      () =>
        new Promise<void>((resolve) => {
          enteredResolvers.push(resolve)
        }),
    )
    const releaseResolvers: Array<() => void> = []
    const snapshots: ReturnType<typeof store.stats>[] = []
    let active = 0
    let maxActive = 0

    const openings = paths.map((documentPath, index) =>
      store.open(documentPath, "x", async () => {
        active++
        maxActive = Math.max(maxActive, active)
        snapshots.push(store.stats())
        enteredResolvers[index]?.()
        await new Promise<void>((resolve) => {
          releaseResolvers[index] = resolve
        })
        active--
      }),
    )

    for (const [index, ready] of entered.entries()) {
      await ready
      expect(active).toBe(1)
      expect(store.stats()).toMatchObject({ openingCount: 1, openingBytes: 1 })
      releaseResolvers[index]?.()
    }

    await Promise.all(openings)

    expect(maxActive).toBe(1)
    expect(snapshots.every((snapshot) => snapshot.openingCount <= 1)).toBe(true)
    expect(store.stats()).toMatchObject({ count: 2, bytes: 2, openingCount: 0, openingBytes: 0 })
  })

  test("concurrent refresh of an eviction candidate settles without lock-order deadlock", async () => {
    const store = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    })
    await store.open("/tmp/occupied.ts", "old")
    const evicted: string[] = []
    store.onEvict((event) => {
      evicted.push(event.path)
    })

    // Path-first lock ordering deadlocks here: the held global turn waits to
    // evict a path whose own open is queued behind that same turn.
    const opening = store.open("/tmp/incoming.ts", "new")
    const refreshing = store.open("/tmp/occupied.ts", "refreshed")

    const [, refreshed] = await Promise.all([opening, refreshing])

    expect(refreshed.metadataOnly).toBe(false)
    expect(evicted).toEqual(["/tmp/occupied.ts", "/tmp/incoming.ts"])
    expect(store.stats()).toMatchObject({ count: 1, bytes: "refreshed".length, openingCount: 0 })
    expect(store.has("/tmp/incoming.ts")).toBe(false)
    const occupied = store.get("/tmp/occupied.ts")
    expect(occupied?.metadataOnly).toBe(false)
    if (occupied && !occupied.metadataOnly) expect(occupied.text).toBe("refreshed")
  }, 5000)

  test("loads deferred sources one at a time inside the open turn", async () => {
    const store = DocumentStore.create({ documentLimit: 10, documentMaxBytes: 10_000 })
    const paths = ["/tmp/one.ts", "/tmp/two.ts", "/tmp/three.ts", "/tmp/four.ts"]
    const loaded: string[] = []
    let active = 0
    let maxActive = 0

    await Promise.all(
      paths.map((documentPath) =>
        store.open(documentPath, async () => {
          active++
          maxActive = Math.max(maxActive, active)
          loaded.push(documentPath)
          await Bun.sleep(5)
          active--
          return `body of ${documentPath}`
        }),
      ),
    )

    expect(maxActive).toBe(1)
    expect(loaded).toEqual(paths)
    expect(store.stats()).toMatchObject({ count: 4, openingCount: 0, openingBytes: 0 })
    const first = store.get("/tmp/one.ts")
    if (first && !first.metadataOnly) expect(first.text).toBe("body of /tmp/one.ts")
  })

  test("bumps generation on eviction and exact zero disables both ceilings", async () => {
    const store = DocumentStore.create({
      documentLimit: 0,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    })
    await store.open("/tmp/a.ts", "a")
    await store.open("/tmp/b.ts", "b")

    expect(store.stats()).toMatchObject({ count: 2, bytes: 2 })
    expect(store.generation).toBe(0)

    const bounded = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 0,
      documentOpenAllowanceBytes: 0,
    })
    await bounded.open("/tmp/a.ts", "a")
    await bounded.open("/tmp/b.ts", "b")
    expect(bounded.generation).toBe(1)
  })

  test("serializes a refresh behind an in-flight didClose", async () => {
    const store = DocumentStore.create({
      documentLimit: 1,
      documentMaxBytes: 64,
      documentOpenAllowanceBytes: 2,
    })
    const events: string[] = []
    await store.open("/tmp/file.ts", "large")
    let release = () => {}
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve
    })
    store.onEvict(async () => {
      events.push("close:start")
      entered()
      await releasePromise
      events.push("close:end")
    })

    const touch = store.touch("/tmp/file.ts")
    await enteredPromise
    const reopen = store.open("/tmp/file.ts", "small", async (event) => {
      events.push(`${event.kind}:${event.text}`)
    })
    await Promise.resolve()
    expect(events).toEqual(["close:start"])

    release()
    await Promise.all([touch, reopen])
    expect(events).toEqual(["close:start", "close:end", "open:small"])
  })
})
