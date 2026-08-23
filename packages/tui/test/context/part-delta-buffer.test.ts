import { describe, expect, test } from "bun:test"
import { createPartDeltaBuffer } from "../../src/context/part-delta-buffer"

describe("part delta buffer", () => {
  test("coalesces deltas per message/part/field and applies once", () => {
    const applied: string[] = []
    const buffer = createPartDeltaBuffer({ intervalMs: 10_000, apply: (e) => applied.push(e.accumulated) })
    buffer.push({ messageID: "m1", partID: "p1", field: "text", delta: "a" })
    buffer.push({ messageID: "m1", partID: "p1", field: "text", delta: "b" })
    buffer.push({ messageID: "m1", partID: "p1", field: "text", delta: "c" })
    buffer.push({ messageID: "m1", partID: "p2", field: "text", delta: "x" })
    expect(applied).toEqual([])
    buffer.flushNow()
    expect(applied).toEqual(["abc", "x"])
  })

  test("dropMessage discards pending deltas for a message", () => {
    const applied: string[] = []
    const buffer = createPartDeltaBuffer({ intervalMs: 10_000, apply: (e) => applied.push(e.accumulated) })
    buffer.push({ messageID: "m1", partID: "p1", field: "text", delta: "a" })
    buffer.dropMessage("m1")
    buffer.flushNow()
    expect(applied).toEqual([])
    expect(buffer.pendingCount()).toBe(0)
  })

  test("flushNow is a no-op when nothing is pending", () => {
    const buffer = createPartDeltaBuffer({ intervalMs: 10_000, apply: () => {} })
    buffer.flushNow()
    expect(buffer.pendingCount()).toBe(0)
  })

  test("burst pushes join into a single linear apply", () => {
    const applied: string[] = []
    const buffer = createPartDeltaBuffer({ intervalMs: 10_000, apply: (e) => applied.push(e.accumulated) })
    const expected = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")
    for (const char of expected) buffer.push({ messageID: "m1", partID: "p1", field: "text", delta: char })
    buffer.flushNow()
    expect(applied).toEqual([expected])
  })
})
