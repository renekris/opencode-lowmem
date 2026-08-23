import { expect, test } from "bun:test"
import {
  compareChildSessions,
  cycleChildSessionID,
  newestChildSessionID,
} from "../../../src/routes/session/child-sessions"

const child = (id: string, created: number, updated = created) => ({
  id,
  parentID: "parent",
  time: { created, updated },
})
const parent: { id: string; parentID?: string; time: { created: number; updated: number } } = {
  id: "parent",
  time: { created: 0, updated: 0 },
}

const sessions = () => [parent, child("b", 20), child("a", 10), child("c", 30)]

test("orders children by last activity ascending", () => {
  const ordered = sessions()
    .filter((x) => x.parentID !== undefined)
    .sort(compareChildSessions)
  expect(ordered.map((x) => x.id)).toEqual(["a", "b", "c"])
})

test("moves a re-activated stale child to the conveyor tail", () => {
  const stale = child("a", 10)
  const activated = [parent, child("b", 20), { ...stale, time: { ...stale.time, updated: 40 } }, child("c", 30)]
  expect(newestChildSessionID(activated)).toBe("a")
  const ordered = activated.filter((x) => x.parentID !== undefined).sort(compareChildSessions)
  expect(ordered.map((x) => x.id)).toEqual(["b", "c", "a"])
})

test("breaks activity ties by descending id (later creation = smaller id)", () => {
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
