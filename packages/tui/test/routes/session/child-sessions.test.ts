import { expect, test } from "bun:test"
import {
  compareChildSessions,
  cycleChildSessionID,
  newestChildSessionID,
} from "../../../src/routes/session/child-sessions"

const child = (id: string, created: number) => ({ id, parentID: "parent", time: { created } })
const parent: { id: string; parentID?: string; time: { created: number } } = { id: "parent", time: { created: 0 } }

const sessions = () => [parent, child("b", 20), child("a", 10), child("c", 30)]

test("orders children by creation time ascending", () => {
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort(compareChildSessions)
  expect(ordered.map((x) => x.id)).toEqual(["a", "b", "c"])
})

test("breaks creation-time ties deterministically by id", () => {
  expect(compareChildSessions(child("a", 5), child("b", 5))).toBe(-1)
  expect(compareChildSessions(child("b", 5), child("a", 5))).toBe(1)
  expect(compareChildSessions(child("a", 5), child("a", 5))).toBe(0)
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

test("cycling over tie timestamps stays deterministic by id", () => {
  const tied = [child("z", 7), child("y", 7), child("x", 7)]
  expect(cycleChildSessionID(tied, "x", 1)).toBe("y")
  expect(cycleChildSessionID(tied, "z", -1)).toBe("y")
  expect(cycleChildSessionID(tied, "y", -1)).toBe("x")
})

test("cycling with no children is a no-op", () => {
  expect(cycleChildSessionID([], "a", 1)).toBeUndefined()
  expect(cycleChildSessionID([], undefined, -1)).toBeUndefined()
})
