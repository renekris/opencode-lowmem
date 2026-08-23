import { beforeEach, describe, expect, test } from "bun:test"
import { forgetInboundChild, inboundChildRank, noteInboundMessage } from "../../../src/routes/session/child-inbound"

const userMsg = (sessionID: string, id: string, created: number) => ({
  id,
  sessionID,
  role: "user",
  time: { created },
})

const allIDs = ["s1", "s2", "s-old", ...Array.from({ length: 256 }, (_, i) => `s-${i}`)]

beforeEach(() => {
  for (const id of allIDs) forgetInboundChild(id)
})

describe("child-inbound rank tracker", () => {
  test("tracks user messages only", () => {
    noteInboundMessage({ id: "m1", sessionID: "s1", role: "user", time: { created: 100 } })
    noteInboundMessage({ id: "m2", sessionID: "s2", role: "assistant", time: { created: 200 } })
    expect(inboundChildRank("s1")).toEqual({ at: 100, ordinal: expect.any(Number) })
    expect(inboundChildRank("s2")).toBeUndefined()
  })

  test("ignores repeated events for the same message id", () => {
    noteInboundMessage(userMsg("s1", "m1", 100))
    const first = inboundChildRank("s1")
    noteInboundMessage(userMsg("s1", "m1", 999))
    expect(inboundChildRank("s1")).toEqual(first)
  })

  test("a newer message id replaces the rank", () => {
    noteInboundMessage(userMsg("s1", "m1", 100))
    noteInboundMessage(userMsg("s1", "m2", 300))
    const rank = inboundChildRank("s1")
    expect(rank?.at).toBe(300)
  })

  test("receipt ordinals are monotonic across sessions", () => {
    noteInboundMessage(userMsg("s1", "m1", 50))
    noteInboundMessage(userMsg("s2", "m2", 50))
    const r1 = inboundChildRank("s1")
    const r2 = inboundChildRank("s2")
    expect(r1 && r2 && r2.ordinal > r1.ordinal).toBe(true)
  })

  test("forget removes the rank", () => {
    noteInboundMessage(userMsg("s1", "m1", 100))
    forgetInboundChild("s1")
    expect(inboundChildRank("s1")).toBeUndefined()
  })

  test("caps tracked children at 256, evicting the least recently updated entry", () => {
    noteInboundMessage(userMsg("s-old", "m-old", 1))
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, `m-${i}`, 10 + i))
    expect(inboundChildRank("s-old")).toBeUndefined()
    expect(inboundChildRank("s-0")).toEqual({ at: 10, ordinal: expect.any(Number) })
    expect(inboundChildRank("s-255")).toBeDefined()
  })
})
