import { expect, test } from "bun:test"
import {
  childSessionWindow,
  compareChildSessions,
  cycleChildSessionID,
  newestChildSessionID,
  type ChildRankLookup,
} from "../../../src/routes/session/child-sessions"
import { describe } from "bun:test"

const child = (id: string, created: number) => ({ id, parentID: "parent", time: { created } })
const parent: { id: string; parentID?: string; time: { created: number } } = { id: "parent", time: { created: 0 } }

const sessions = () => [parent, child("b", 20), child("a", 10), child("c", 30)]

const ranker =
  (entries: Record<string, { at: number; ordinal: number }>): ChildRankLookup =>
  (sessionID) =>
    entries[sessionID]

test("orders children by creation time ascending without ranks", () => {
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort(compareChildSessions)
  expect(ordered.map((x) => x.id)).toEqual(["a", "b", "c"])
})

test("an inbound message rank moves only the receiving child to the tail", () => {
  const rank = ranker({ a: { at: 40, ordinal: 0 } })
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort((x, y) => compareChildSessions(x, y, rank))
  expect(ordered.map((x) => x.id)).toEqual(["b", "c", "a"])
  expect(newestChildSessionID(sessions(), rank)).toBe("a")
})

test("ranked children sort among themselves by receipt ordinal within the same millisecond", () => {
  const rank = ranker({ a: { at: 50, ordinal: 1 }, b: { at: 50, ordinal: 0 } })
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort((x, y) => compareChildSessions(x, y, rank))
  expect(ordered.map((x) => x.id)).toEqual(["c", "b", "a"])
})

test("unranked children fall back to creation order while ranked ones rank ahead by receipt time", () => {
  const rank = ranker({ c: { at: 5, ordinal: 0 } })
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort((x, y) => compareChildSessions(x, y, rank))
  expect(ordered.map((x) => x.id)).toEqual(["c", "a", "b"])
})

test("breaks tie timestamps by descending id (later creation = smaller id)", () => {
  expect(compareChildSessions(child("a", 5), child("b", 5))).toBe(1)
  expect(compareChildSessions(child("b", 5), child("a", 5))).toBe(-1)
  expect(compareChildSessions(child("a", 5), child("a", 5))).toBe(0)
})

test("same-millisecond descending session ids keep causal order", () => {
  // SessionID.descending(): created later in the same ms -> lexically smaller id.
  const first = child("ses_9f2", 500)
  const second = child("ses_9f1", 500)
  const third = child("ses_9f0", 500)
  expect(newestChildSessionID([third, first, second])).toBe("ses_9f0")
  expect(cycleChildSessionID([third, first, second], "ses_9f2", 1)).toBe("ses_9f1")
})

test("newest child is the conveyor tail and ignores non-child rows", () => {
  expect(newestChildSessionID(sessions())).toBe("c")
  expect(newestChildSessionID([parent])).toBeUndefined()
  expect(newestChildSessionID([])).toBeUndefined()
})

test("cycling +1 steps toward the newest child", () => {
  expect(cycleChildSessionID(sessions(), "a", 1)).toBe("b")
  expect(cycleChildSessionID(sessions(), "b", 1)).toBe("c")
})

test("cycling +1 from the newest wraps to the oldest", () => {
  expect(cycleChildSessionID(sessions(), "c", 1)).toBe("a")
})

test("cycling -1 steps toward the oldest and wraps from the oldest to the newest", () => {
  expect(cycleChildSessionID(sessions(), "c", -1)).toBe("b")
  expect(cycleChildSessionID(sessions(), "b", -1)).toBe("a")
  expect(cycleChildSessionID(sessions(), "a", -1)).toBe("c")
})

test("unknown current resolves to the oldest for +1 and newest for -1", () => {
  expect(cycleChildSessionID(sessions(), undefined, 1)).toBe("a")
  expect(cycleChildSessionID(sessions(), undefined, -1)).toBe("c")
})

test("cycling uses conveyor order for a re-ranked child", () => {
  const rank = ranker({ a: { at: 40, ordinal: 0 } })
  expect(cycleChildSessionID(sessions(), "c", 1, rank)).toBe("a")
  expect(cycleChildSessionID(sessions(), "a", 1, rank)).toBe("b")
})

test("cycling over tie timestamps stays deterministic by descending id", () => {
  const tied = [child("z", 7), child("y", 7), child("x", 7)]
  expect(cycleChildSessionID(tied, "z", 1)).toBe("y")
  expect(cycleChildSessionID(tied, "x", -1)).toBe("y")
  expect(cycleChildSessionID(tied, "y", -1)).toBe("z")
  expect(newestChildSessionID(tied)).toBe("x")
})

test("cycling with no children is a no-op", () => {
  expect(cycleChildSessionID([], "a", 1)).toBeUndefined()
  expect(cycleChildSessionID([], undefined, -1)).toBeUndefined()
})

describe("child conveyor window", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => child(`c${i + 1}`, i + 1))

  test("keeps only the newest 50 children in conveyor order", () => {
    const w = childSessionWindow(many(52))
    expect(w.length).toBe(50)
    expect(w[0]?.id).toBe("c3")
    expect(w.at(-1)?.id).toBe("c52")
  })

  test("returns all children at or below the limit and excludes non-child rows", () => {
    const w = childSessionWindow([parent, ...many(50)])
    expect(w.length).toBe(50)
    expect(w[0]?.id).toBe("c1")
  })

  test("pins a viewed out-of-window child by displacing the window oldest", () => {
    const w = childSessionWindow(many(52), undefined, "c1")
    expect(w.length).toBe(50)
    expect(w.some((x) => x.id === "c1")).toBe(true)
    expect(w.some((x) => x.id === "c3")).toBe(false)
    expect(w.map((x) => parseInt(x.id.slice(1)))).toEqual([
      1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    ])
  })

  test("cycling wraps at window edges, not the full family", () => {
    const kids = many(52)
    expect(cycleChildSessionID(kids, "c3", -1)).toBe("c52")
    expect(cycleChildSessionID(kids, "c52", 1)).toBe("c3")
  })

  test("cycling from a pinned child moves within the pinned window", () => {
    const kids = many(52)
    expect(cycleChildSessionID(kids, "c1", 1, undefined)).toBe("c4")
    expect(cycleChildSessionID(kids, "c1", -1, undefined)).toBe("c52")
  })

  test("a ranked old child re-enters at the tail and drops the window head", () => {
    const rank = ranker({ c1: { at: 100, ordinal: 0 } })
    const w = childSessionWindow(many(52), rank)
    expect(w.at(-1)?.id).toBe("c1")
    expect(w[0]?.id).toBe("c4")
    expect(w.some((x) => x.id === "c2")).toBe(false)
    expect(w.some((x) => x.id === "c3")).toBe(false)
  })

  test("newest child resolution respects the window", () => {
    expect(newestChildSessionID(many(52))).toBe("c52")
    expect(newestChildSessionID(many(52), ranker({ c1: { at: 100, ordinal: 0 } }))).toBe("c1")
  })
})
