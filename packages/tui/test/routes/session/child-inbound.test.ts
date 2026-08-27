import { beforeEach, describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import {
  forgetInboundChild,
  inboundChildRank,
  noteInboundMessage,
  setViewedChild,
} from "../../../src/routes/session/child-inbound"
import { cycleChildSessionID } from "../../../src/routes/session/child-sessions"

const userMsg = (sessionID: string, created: number, id = `msg_${sessionID}_${created}`) => ({
  id,
  sessionID,
  role: "user",
  time: { created },
})

const conveyorIDs = Array.from({ length: 50 }, (_, i) => `c${i + 1}`)
const allIDs = [
  "s1",
  "s2",
  "s-compaction",
  "s-dup",
  "s-late",
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
  setViewedChild(undefined)
  for (const id of allIDs) forgetInboundChild(id)
})

describe("child-inbound rank tracker", () => {
  test("tracks user messages only", () => {
    noteInboundMessage(userMsg("s1", 100))
    noteInboundMessage({ id: "m2", sessionID: "s2", role: "assistant", time: { created: 200 } })
    expect(inboundChildRank("s1")).toEqual({ at: 100, ordinal: expect.any(Number) })
    expect(inboundChildRank("s2")).toBeUndefined()
  })

  test("a later user message moves the child to the tail", () => {
    noteInboundMessage(userMsg("s1", 100))
    const first = inboundChildRank("s1")
    noteInboundMessage(userMsg("s1", 300))
    const second = inboundChildRank("s1")
    expect(second?.at).toBe(300)
    expect(second && first && second.ordinal > first.ordinal).toBe(true)
  })

  test("a compaction-agent user message still re-ranks", () => {
    const first = { ...userMsg("s-compaction", 100), agent: "compaction" }
    noteInboundMessage(first)
    const later = { ...userMsg("s-compaction", 300, "msg_later"), agent: "compaction" }
    noteInboundMessage(later)
    expect(inboundChildRank("s-compaction")?.at).toBe(300)
  })

  test("a duplicated message event never re-ranks", () => {
    noteInboundMessage(userMsg("s-dup", 100, "msg_a"))
    const first = inboundChildRank("s-dup")
    noteInboundMessage(userMsg("s-dup", 100, "msg_a"))
    expect(inboundChildRank("s-dup")).toEqual(first)
  })

  test("an out-of-order older message never moves the rank backwards", () => {
    noteInboundMessage(userMsg("s-late", 300, "msg_new"))
    const latest = inboundChildRank("s-late")
    noteInboundMessage(userMsg("s-late", 100, "msg_old"))
    expect(inboundChildRank("s-late")).toEqual(latest)
  })

  test("a different message id at the same timestamp counts as newer", () => {
    noteInboundMessage(userMsg("s1", 100, "msg_a"))
    const first = inboundChildRank("s1")
    noteInboundMessage(userMsg("s1", 100, "msg_b"))
    const second = inboundChildRank("s1")
    expect(second && first && second.ordinal > first.ordinal).toBe(true)
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

  test("re-messages update in place and never consume capacity", () => {
    noteInboundMessage(userMsg("s-refresh", 1))
    noteInboundMessage(userMsg("s-refresh", 2))
    noteInboundMessage(userMsg("s-cold", 3))
    for (let i = 0; i < 254; i++) noteInboundMessage(userMsg(`s-warm-${i}`, 4 + i))
    expect(inboundChildRank("s-refresh")?.at).toBe(2)
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

  test("continuations beyond capacity update ranked children in place without evicting others", () => {
    noteInboundMessage(userMsg("s-old", 1))
    for (let i = 0; i < 255; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    noteInboundMessage(userMsg("s-old", 9999))
    expect(inboundChildRank("s-old")?.at).toBe(9999)
    expect(inboundChildRank("s-254")).toBeDefined()
    noteInboundMessage(userMsg("s-beyond", 5000))
    expect(inboundChildRank("s-beyond")).toBeUndefined()
  })

  test("forget frees a slot so the next first message can rank", () => {
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    forgetInboundChild("s-100")
    noteInboundMessage(userMsg("s-freed", 9999))
    expect(inboundChildRank("s-freed")?.at).toBe(9999)
  })
})

describe("viewed-child pin", () => {
  test("a continuation on the viewed child defers: footer math stable while pinned, latest applies on release", () => {
    for (let i = 1; i <= 50; i++) noteInboundMessage(userMsg(`c${i}`, i))
    const kids = conveyorIDs.map((id, i) => ({ id, parentID: "root", time: { created: i + 1 } }))
    setViewedChild("c48")
    noteInboundMessage(userMsg("c48", 9998, "msg_cont_1"))
    noteInboundMessage(userMsg("c48", 9999, "msg_cont_2"))
    expect(inboundChildRank("c48")?.at).toBe(48)
    expect(cycleChildSessionID(kids, "c48", 1, inboundChildRank)).toBe("c49")
    expect(cycleChildSessionID(kids, "c50", 1, inboundChildRank)).toBe("c1")
    setViewedChild(undefined)
    expect(inboundChildRank("c48")?.at).toBe(9999)
  })

  test("unpinning another child releases the pin without applying anything to the new child", () => {
    noteInboundMessage(userMsg("c1", 1))
    noteInboundMessage(userMsg("c2", 2))
    setViewedChild("c1")
    noteInboundMessage(userMsg("c2", 8888))
    setViewedChild("c2")
    expect(inboundChildRank("c2")?.at).toBe(8888)
    expect(inboundChildRank("c1")?.at).toBe(1)
  })

  test("a pinned child deleted then unpinned restores no rank or deferred touch", () => {
    noteInboundMessage(userMsg("c48", 48))
    setViewedChild("c48")
    noteInboundMessage(userMsg("c48", 9999))
    forgetInboundChild("c48")
    setViewedChild(undefined)
    expect(inboundChildRank("c48")).toBeUndefined()
  })

  test("a deferred rank for an unranked child respects the capacity cap on commit", () => {
    for (let i = 0; i < 256; i++) noteInboundMessage(userMsg(`s-${i}`, 10 + i))
    setViewedChild("s-beyond")
    noteInboundMessage(userMsg("s-beyond", 5000))
    setViewedChild(undefined)
    expect(inboundChildRank("s-beyond")).toBeUndefined()
  })

  test("rank reads are reactive: a memo re-runs when another child re-ranks", () => {
    createRoot((dispose) => {
      noteInboundMessage(userMsg("c10", 10))
      let runs = 0
      const memo = createMemo(() => {
        runs++
        return conveyorIDs.map((id) => inboundChildRank(id)?.at ?? -1)
      })
      memo()
      const before = runs
      noteInboundMessage(userMsg("c10", 8888))
      expect(memo()[9]).toBe(8888)
      expect(runs).toBeGreaterThan(before)
      dispose()
    })
  })
})

describe("conveyor stability under automation", () => {
  test("a delegation to a new child ranks it at the conveyor tail", () => {
    noteInboundMessage(userMsg("c1", 1))
    const kids = [{ id: "c1", parentID: "root", time: { created: 1 } }]
    noteInboundMessage(userMsg("c2", 9999))
    kids.push({ id: "c2", parentID: "root", time: { created: 2 } })
    expect(cycleChildSessionID(kids, "c1", 1, inboundChildRank)).toBe("c2")
  })
})
