/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import { emitMessage, emitRow, fetchFor, global, message, row, withPayloadLimits } from "./root-hot-window-fixture"

test("returning from a child keeps the bounded root resident without refetching", async () => {
  await withPayloadLimits({ budget: "0", sessions: "2" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_hot_root")
    const child = row("ses_hot_child", root.id)
    const grandchild = row("ses_hot_grandchild", child.id)
    const rows = new Map([[root.id, root], [child.id, child], [grandchild.id, grandchild]])
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(fetchFor(rows, calls), tmp.path)

    try {
      await sync.session.sync(root.id)
      emitRow(emit, child)
      emitRow(emit, grandchild)
      await wait(() => sync.data.session.find((session) => session.id === grandchild.id)?.parentID === child.id)
      sync.session.activate(grandchild.id)
      await sync.session.sync(grandchild.id)
      for (let index = 0; index < 4; index++) {
        const sessionID = `ses_ordinary_${index}`
        await sync.session.sync(sessionID)
      }
      await wait(() => sync.payload.stats().evictions >= 2)

      expect(sync.data.message[root.id]).toHaveLength(1)
      expect(sync.session.isEvicted(root.id)).toBe(false)
      expect(sync.data.message.ses_ordinary_0).toBeUndefined()
      const beforeReturn = calls.get(root.id)

      await sync.session.sync(root.id)

      expect(calls.get(root.id)).toBe(beforeReturn)
      expect(sync.data.message[root.id]).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("root pressure removes oldest complete buckets but keeps a coherent hot suffix", async () => {
  await withPayloadLimits({ budget: "1MB", sessions: "0" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_trim_root")
    const child = row("ses_trim_child", root.id)
    const { app, emit, sync } = await mount(fetchFor(new Map(), new Map()), tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, child)
      sync.session.activate(child.id)
      for (let index = 0; index < 3; index++) {
        const info = message(root.id, index, 220_000)
        emitMessage(emit, info)
        emit(
          global({
            id: `evt_part_${index}`,
            type: "message.part.updated",
            properties: {
              sessionID: root.id,
              time: index,
              part: { id: `part_${index}`, sessionID: root.id, messageID: info.id, type: "text", text: "part" },
            },
          }),
        )
      }
      await wait(() => (sync.data.message[root.id]?.length ?? 0) === 2)

      expect(sync.session.isEvicted(root.id)).toBe(false)
      expect(sync.data.message[root.id]?.map((item) => item.id)).toEqual([
        `msg_${root.id}_1`,
        `msg_${root.id}_2`,
      ])
      expect(sync.data.part[`msg_${root.id}_0`]).toBeUndefined()
      expect(sync.data.part[`msg_${root.id}_1`]).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("an oversized root blocks late events and rehydrates only on explicit activation", async () => {
  await withPayloadLimits({ budget: "1MB", sessions: "0" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_emergency_root")
    const child = row("ses_emergency_child", root.id)
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(fetchFor(new Map([[root.id, root], [child.id, child]]), calls), tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, child)
      sync.session.activate(child.id)
      emit(
        global({
          id: "evt_root_todo",
          type: "todo.updated",
          properties: { sessionID: root.id, todos: [{ content: "bounded", status: "pending", priority: "medium" }] },
        }),
      )
      emit(global({ id: "evt_root_diff", type: "session.diff", properties: { sessionID: root.id, diff: [] } }))
      emitMessage(emit, message(root.id, 0, 700_000))
      await wait(() => sync.session.isEvicted(root.id))

      expect(sync.data.message[root.id]).toBeUndefined()
      expect(sync.data.todo[root.id]).toBeUndefined()
      expect(sync.data.session_diff[root.id]).toBeUndefined()

      emitMessage(emit, message(root.id, 1))
      await wait(() => sync.data.message[root.id] === undefined)
      expect(sync.session.isEvicted(root.id)).toBe(true)
      const callsBeforeActivation = calls.get(root.id) ?? 0

      sync.session.activate(root.id)
      await sync.session.sync(root.id)

      expect(callsBeforeActivation).toBe(0)
      expect(calls.get(root.id)).toBeGreaterThan(callsBeforeActivation)
      expect(sync.data.message[root.id]).toHaveLength(1)
      expect(sync.session.isEvicted(root.id)).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("the active root stays visible until a child activates its bounded hot window", async () => {
  await withPayloadLimits({ budget: "1MB", sessions: "0" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_active_root")
    const child = row("ses_active_child", root.id)
    const { app, emit, sync } = await mount(fetchFor(new Map(), new Map()), tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id)?.parentID === root.id)
      sync.session.activate(root.id)
      emitMessage(emit, message(root.id, 0, 700_000))
      await wait(() => sync.data.message[root.id]?.length === 1)

      expect(sync.session.isEvicted(root.id)).toBe(false)

      sync.session.activate(child.id)

      await wait(() => sync.session.isEvicted(root.id))
      expect(sync.data.message[root.id]).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
