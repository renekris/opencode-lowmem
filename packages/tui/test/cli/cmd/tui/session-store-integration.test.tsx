/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import {
  emitCreated,
  emitDeleted,
  emitMessage,
  emitMoved,
  emitRow,
  fetchFor,
  row,
  userMessage,
  withSessionLimit,
} from "./root-eviction-fixture"
import { forgetInboundChild, inboundChildRank } from "../../../../src/routes/session/child-inbound"
import { childSessionWindow } from "../../../../src/routes/session/child-sessions"
import type { FetchHandler } from "../../../fixture/tui-sdk"

const listFetch =
  (rows: Map<string, ReturnType<typeof row>>): FetchHandler =>
  (url) => {
    if (url.pathname === "/session") return json([...rows.values()])
    return fetchFor(rows, new Map())(url)
  }

test("a stale session list cannot drop a row a live event just created", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const rows = new Map([[root.id, root]])
    let deferList = false
    const listWaiters: ((body: ReturnType<typeof row>[]) => void)[] = []
    const handler: FetchHandler = (url) => {
      if (url.pathname === "/session") {
        if (!deferList) return json([...rows.values()])
        return new Promise<Response>((resolve) => {
          listWaiters.push((body) => resolve(json(body)))
        })
      }
      return fetchFor(rows, new Map())(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      await wait(() => sync.data.session.find((session) => session.id === root.id) !== undefined)
      deferList = true
      const refreshing = sync.session.refresh()
      await wait(() => listWaiters.length > 0)
      emitCreated(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      for (const resolve of listWaiters) resolve([root])
      await refreshing
      expect(sync.data.session.find((session) => session.id === child.id)).toBeDefined()
    } finally {
      forgetInboundChild(child.id)
      app.renderer.destroy()
    }
  })
})

test("a stale session list cannot resurrect a session deleted mid-flight", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    let deferList = false
    const listWaiters: ((body: ReturnType<typeof row>[]) => void)[] = []
    const handler: FetchHandler = (url) => {
      if (url.pathname === "/session") {
        if (!deferList) return json([...rows.values()])
        return new Promise<Response>((resolve) => {
          listWaiters.push((body) => resolve(json(body)))
        })
      }
      return fetchFor(rows, new Map())(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      deferList = true
      const refreshing = sync.session.refresh()
      await wait(() => listWaiters.length > 0)
      emitDeleted(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) === undefined)
      for (const resolve of listWaiters) resolve([root, child])
      await refreshing
      expect(sync.data.session.find((session) => session.id === child.id)).toBeUndefined()
    } finally {
      forgetInboundChild(child.id)
      app.renderer.destroy()
    }
  })
})

test("a live session.updated during session.sync hydration wins over the stale GET", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const eventRow = { ...row("ses_slow", root.id), title: "from-event" }
    const getRow = { ...eventRow, title: "from-get" }
    const rows = new Map([
      [root.id, root],
      ["ses_slow", getRow],
    ])
    const pending: ((info: ReturnType<typeof row>) => void)[] = []
    const handler: FetchHandler = (url) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (session && session[1] === "ses_slow") {
        return new Promise<Response>((resolve) => {
          pending.push((info) => resolve(json(info)))
        })
      }
      return listFetch(rows)(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, eventRow)
      await wait(() => sync.data.session.find((session) => session.id === "ses_slow") !== undefined)
      void sync.session.sync("ses_slow")
      await wait(() => pending.length > 0)
      emitRow(emit, { ...eventRow, title: "live-newer" })
      await wait(() => sync.data.session.find((session) => session.id === "ses_slow")?.title === "live-newer")
      for (const resolve of pending) resolve(getRow)
      await wait(() => sync.data.message["ses_slow"] !== undefined)
      expect(sync.data.session.find((session) => session.id === "ses_slow")?.title).toBe("live-newer")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a stale session GET cannot overwrite a row a newer list application wrote", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = { ...row("ses_child", root.id), title: "list-v1" }
    const newer = { ...child, title: "list-v2" }
    const older = { ...child, title: "get-v1" }
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    const pending: ((info: ReturnType<typeof row>) => void)[] = []
    const handler: FetchHandler = (url) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (session && session[1] === child.id) {
        return new Promise<Response>((resolve) => {
          pending.push((info) => resolve(json(info)))
        })
      }
      if (url.pathname === "/session") return json([...rows.values()])
      return fetchFor(rows, new Map())(url)
    }
    const { app, sync } = await mount(handler, tmp.path)

    try {
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      void sync.session.sync(child.id)
      await wait(() => pending.length > 0)
      rows.set(child.id, newer)
      await sync.session.refresh()
      expect(sync.data.session.find((session) => session.id === child.id)?.title).toBe("list-v2")
      for (const resolve of pending) resolve(older)
      await wait(() => sync.data.message[child.id] !== undefined)
      expect(sync.data.session.find((session) => session.id === child.id)?.title).toBe("list-v2")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a delegation wave keeps fresh children at the tail and moves the continuation last", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const stale = row("ses_stale", root.id)
    const old = row("ses_old", root.id)
    const fresh = [row("ses_fresh_1", root.id), row("ses_fresh_2", root.id), row("ses_fresh_3", root.id)]
    const rows = new Map([
      [root.id, root],
      [stale.id, stale],
      [old.id, old],
      ...fresh.map((info) => [info.id, info] as const),
    ])
    const { app, emit, sync } = await mount(listFetch(rows), tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, stale)
      emitRow(emit, old)
      emitMessage(emit, userMessage(old.id, 100))
      for (const [index, info] of fresh.entries()) {
        emitCreated(emit, info)
        emitMessage(emit, userMessage(info.id, 200 + index))
      }
      emitMessage(emit, userMessage(old.id, 204))
      await wait(() => sync.data.session.find((session) => session.id === fresh[2].id) !== undefined)
      await wait(() => inboundChildRank(old.id)?.at === 204)
      const siblings = sync.data.session.filter((session) => session.parentID === root.id)
      const window = childSessionWindow(siblings, inboundChildRank, undefined)
      const ids = window.map((session) => session.id)
      expect(ids).toEqual([stale.id, fresh[0].id, fresh[1].id, fresh[2].id, old.id])
    } finally {
      for (const info of [stale, old, ...fresh]) forgetInboundChild(info.id)
      app.renderer.destroy()
    }
  })
})

test("a stale session list cannot drop a session.next.moved row mutated mid-flight", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    let deferList = false
    const listWaiters: ((body: ReturnType<typeof row>[]) => void)[] = []
    const handler: FetchHandler = (url) => {
      if (url.pathname === "/session") {
        if (!deferList) return json([...rows.values()])
        return new Promise<Response>((resolve) => {
          listWaiters.push((body) => resolve(json(body)))
        })
      }
      return fetchFor(rows, new Map())(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitRow(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      deferList = true
      const refreshing = sync.session.refresh()
      await wait(() => listWaiters.length > 0)
      emitMoved(emit, child.id, "/srv/moved-project")
      await wait(
        () => sync.data.session.find((session) => session.id === child.id)?.directory === "/srv/moved-project",
      )
      for (const resolve of listWaiters) resolve([root])
      await refreshing
      const moved = sync.data.session.find((session) => session.id === child.id)
      expect(moved?.directory).toBe("/srv/moved-project")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a stale session list cannot revert a moved row it still lists with old contents", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    let deferList = false
    const listWaiters: ((body: ReturnType<typeof row>[]) => void)[] = []
    const handler: FetchHandler = (url) => {
      if (url.pathname === "/session") {
        if (!deferList) return json([...rows.values()])
        return new Promise<Response>((resolve) => {
          listWaiters.push((body) => resolve(json(body)))
        })
      }
      return fetchFor(rows, new Map())(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      deferList = true
      const refreshing = sync.session.refresh()
      await wait(() => listWaiters.length > 0)
      emitMoved(emit, child.id, "/srv/moved-project")
      await wait(
        () => sync.data.session.find((session) => session.id === child.id)?.directory === "/srv/moved-project",
      )
      for (const resolve of listWaiters) resolve([root, child])
      await refreshing
      const moved = sync.data.session.find((session) => session.id === child.id)
      expect(moved?.directory).toBe("/srv/moved-project")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("session.sync overwrites a list-sourced row no live event touched", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const staleRow = { ...row("ses_listed", root.id), title: "from-list" }
    const freshRow = { ...staleRow, title: "from-get" }
    const rows = new Map([
      [root.id, root],
      [staleRow.id, staleRow],
    ])
    const handler: FetchHandler = (url) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (session && session[1] === staleRow.id) return json(freshRow)
      return listFetch(rows)(url)
    }
    const { app, sync } = await mount(handler, tmp.path)

    try {
      await wait(() => sync.data.session.find((session) => session.id === staleRow.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === staleRow.id)?.title).toBe("from-list")
      await sync.session.sync(staleRow.id)
      expect(sync.data.session.find((session) => session.id === staleRow.id)?.title).toBe("from-get")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a late user message for an evicted rowless child re-ranks it without another GET", async () => {
  await withSessionLimit("2", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const target = row("ses_slow", root.id)
    const pressure = [row("ses_pressure_1", root.id), row("ses_pressure_2", root.id)]
    const rows = new Map([[root.id, root], ...pressure.map((info) => [info.id, info] as const)])
    const calls = new Map<string, number>()
    const sessionGets: string[] = []
    const handler: FetchHandler = (url) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (session && session[1] === target.id) {
        sessionGets.push(session[1])
        calls.set(session[1], (calls.get(session[1]) ?? 0) + 1)
        return new Promise<Response>(() => {})
      }
      return listFetch(rows)(url)
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitMessage(emit, userMessage(target.id, 100))
      await wait(() => (calls.get(target.id) ?? 0) === 1)
      emitMessage(emit, userMessage(pressure[0].id, 101))
      emitMessage(emit, userMessage(pressure[1].id, 102))
      await wait(() => sync.data.message[pressure[1].id] !== undefined)
      expect(sync.session.isEvicted(target.id)).toBe(true)
      emitMessage(emit, userMessage(target.id, 200))
      await wait(() => inboundChildRank(target.id)?.at === 200)
      expect(calls.get(target.id) ?? 0).toBe(1)
      expect(sessionGets).toEqual([target.id])
    } finally {
      for (const info of [target, ...pressure]) forgetInboundChild(info.id)
      app.renderer.destroy()
    }
  })
})
