/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import { emitMessage, emitRow, fetchFor, message, row, withSessionLimit } from "./root-eviction-fixture"

test("an inactive root evicts normally and rehydrates only after explicit return", async () => {
  await withSessionLimit("2", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(fetchFor(rows, calls), tmp.path)

    try {
      await sync.session.sync(root.id)
      emitRow(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id)?.parentID === root.id)
      sync.session.activate(child.id)
      await sync.session.sync(child.id)
      for (let index = 0; index < 3; index++) await sync.session.sync(`ses_pressure_${index}`)

      await wait(() => sync.data.message[root.id] === undefined)
      expect(sync.session.isEvicted(root.id)).toBe(true)
      expect(sync.data.message[child.id]).toHaveLength(1)

      emitMessage(emit, message(root.id, 1))
      await Bun.sleep(50)
      expect(sync.data.message[root.id]).toBeUndefined()
      const callsBeforeReturn = calls.get(root.id) ?? 0

      sync.session.activate(root.id)
      await sync.session.sync(root.id)

      expect(calls.get(root.id)).toBeGreaterThan(callsBeforeReturn)
      expect(sync.data.message[root.id]).toHaveLength(1)
      expect(sync.session.isEvicted(root.id)).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })
})
