import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { emitRow, fetchFor, row, withPayloadLimits } from "./root-hot-window-fixture"
import { mount, wait } from "./sync-fixture"

test("reparenting moves root preference before the next payload pressure", async () => {
  await withPayloadLimits({ budget: "0", sessions: "1" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const rootA = row("ses_reparent_root_a")
    const rootB = row("ses_reparent_root_b")
    const child = row("ses_reparent_child", rootA.id)
    const rows = new Map([[rootA.id, rootA], [rootB.id, rootB]])
    const { app, emit, sync } = await mount(fetchFor(rows, new Map()), tmp.path)

    try {
      emitRow(emit, rootA)
      emitRow(emit, rootB)
      emitRow(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id)?.parentID === rootA.id)
      await sync.session.sync(rootA.id)
      sync.session.activate(child.id)
      await sync.session.sync(rootB.id)
      expect(sync.data.message[rootA.id]).toHaveLength(1)
      expect(sync.session.isEvicted(rootB.id)).toBe(false)
      expect(sync.data.message[rootB.id]).toHaveLength(1)

      emitRow(emit, row(child.id, rootB.id))
      await wait(() => sync.data.session.find((session) => session.id === child.id)?.parentID === rootB.id)
      await sync.session.sync("ses_reparent_pressure")

      expect(Object.keys(sync.data.message).sort()).toEqual([rootB.id, "ses_reparent_pressure"].sort())
      expect(sync.session.isEvicted(rootB.id)).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("cyclic ancestry grants no root preference", async () => {
  await withPayloadLimits({ budget: "0", sessions: "1" }, async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionA = row("ses_cycle_a", "ses_cycle_b")
    const sessionB = row("ses_cycle_b", "ses_cycle_a")
    const rows = new Map([[sessionA.id, sessionA], [sessionB.id, sessionB]])
    const { app, emit, sync } = await mount(fetchFor(rows, new Map()), tmp.path)

    try {
      emitRow(emit, sessionA)
      emitRow(emit, sessionB)
      await wait(() => sync.data.session.find((session) => session.id === sessionB.id)?.parentID === sessionA.id)
      sync.session.activate(sessionA.id)
      await sync.session.sync(sessionB.id)
      await sync.session.sync("ses_cycle_pressure")

      expect(sync.data.message[sessionB.id]).toBeUndefined()
      expect(sync.session.isEvicted(sessionB.id)).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })
})
