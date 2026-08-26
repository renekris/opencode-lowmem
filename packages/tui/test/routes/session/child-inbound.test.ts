import { beforeEach, describe, expect, test } from "bun:test"
import { forgetInboundChild, inboundChildRank, noteInboundMessage } from "../../../src/routes/session/child-inbound"
import { cycleChildSessionID } from "../../../src/routes/session/child-sessions"

const userMsg = (sessionID: string, created: number) => ({
  sessionID,
  role: "user",
  time: { created },
})

const conveyorIDs = Array.from({ length: 50 }, (_, i) => `c${i + 1}`)
const allIDs = [
  "s1",
  "s2",
  "s-old",
  "s-refresh",
  "s-cold",
  "s-new",
  "s-beyond",
  "s-freed",
  ...Array.from({ length: 254 }, (_, i) => `s-warm-${i}`),
  ...Array.from({ length: 400 }, (_, i) => `s-${i}`),
  ...conveyorIDs,
]

beforeEach(() => {
  for (const id of allIDs) forgetInboundChild(id)
})

describe("child-inbound rank tracker", () => {
  test("tracks user messages only", () => {
    noteInboundMessage({ sessionID: "s1", role: "user", time: { created: 100 } })
    noteInboundMessage({ sessionID: "s2", role: "assistant", time: { created: 200 } })
    expect(inboundChildRank("s1")).toEqual({ at: 100, ordinal: expect.any(Number) })
    expect(inboundChildRank("s2")).toBeUndefined()
  })

  test("a later user message never re-ranks an already-ranked child", () => {
    noteInboundMessage(userMsg("s1", 100))
    const first = inboundChildRank("s1")
    noteInboundMessage(userMsg("s1", 300))
    expect(inboundChildRank("s1")).toEqual(first)
  })

  test("receipt ordinals are monotonic across sessions", () => {
    noteInboundMessage(userMsg("s1", 50))
    noteInboundMessage(userMsg("s2", 50))
    const r1 = inboundChildRank("s1")
    const r2 = inboundChildRank("s2")
    expect(r1 && r2 && r2.ordinal > r1.ordinal).toBe(true)
  })

  test("forget removes the rank and the next first message re-ranks the child", () => {
    noteInboundMessage(userMsg("s1", 100))
    forgetInboundChild("s1")
    expect(inboundChildRank("s1")).toBeUndefined()
    noteInboundMessage(userMsg("s1", 500))
    expect(inboundChildRank("s1")?.at).toBe(500)
  })

  test("re-messages do not consume capacity: the first-ranked child still holds its rank after CAP more messages", () => {
    noteInboundMessage(userMsg("s-refresh", 1))
    noteInboundMessage(userMsg("s-refresh", 2))
    noteInboundMessage(userMsg("s-cold", 3))
    for (let i = 0; i < 254; i++) noteInboundMessage(userMsg(`s-warm-${i}`, 4 + i))
    expect(inboundChildRank("s-refresh")).toEqual({ at: 1, ordinal: expect.any(Number) })
    expect(inboundChildRank("s-cold")).toBeDefined()
    expect(inboundChildRank("s-warm-253")).toBeDefined()
  })

  test("ranks at most the first CAP distinct children; later first messages fall back to creation time", () => {
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    noteInboundMessage(userMsg("s-new", 9999))
    expect(inboundChildRank("s-new")).toBeUndefined()
    expect(inboundChildRank("s-0")).toEqual({ at: 10, ordinal: expect.any(Number) })
    expect(inboundChildRank("s-255")).toBeDefined()
  })

  test("capacity pressure never re-ranks an already-ranked child (no tail jump)", () => {
    noteInboundMessage(userMsg("s-old", 1))
    for (let i = 0; i < 255; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    for (let i = 256; i < 400; i++) noteInboundMessage(userMsg(`s-${i}`, 1000 + i))
    noteInboundMessage(userMsg("s-old", 9999))
    expect(inboundChildRank("s-old")).toEqual({ at: 1, ordinal: expect.any(Number) })
    expect(inboundChildRank("s-300")).toBeUndefined()
  })

  test("a continuation on an unranked child beyond capacity never inserts a rank", () => {
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    noteInboundMessage(userMsg("s-beyond", 5000))
    noteInboundMessage(userMsg("s-beyond", 6000))
    expect(inboundChildRank("s-beyond")).toBeUndefined()
  })

  test("forget frees a slot so the next first message can rank", () => {
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    forgetInboundChild("s-100")
    noteInboundMessage(userMsg("s-freed", 9999))
    expect(inboundChildRank("s-freed")?.at).toBe(9999)
  })
})

describe("conveyor stability under automation", () => {
  test("a continuation on the viewed child keeps footer math stable: right from 48 is still 49", () => {
    for (let i = 1; i <= 50; i++) noteInboundMessage(userMsg(`c${i}`, i))
    const kids = conveyorIDs.map((id, i) => ({ id, parentID: "root", time: { created: i + 1 } }))
    noteInboundMessage(userMsg("c48", 9999))
    expect(cycleChildSessionID(kids, "c48", 1, inboundChildRank)).toBe("c49")
    expect(cycleChildSessionID(kids, "c50", 1, inboundChildRank)).toBe("c1")
  })

  test("a delegation to a new child ranks it at the conveyor tail", () => {
    noteInboundMessage(userMsg("c1", 1))
    const kids = [{ id: "c1", parentID: "root", time: { created: 1 } }]
    noteInboundMessage(userMsg("c2", 9999))
    kids.push({ id: "c2", parentID: "root", time: { created: 2 } })
    expect(cycleChildSessionID(kids, "c1", 1, inboundChildRank)).toBe("c2")
  })
})
