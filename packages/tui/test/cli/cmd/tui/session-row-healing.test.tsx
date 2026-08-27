/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait, json } from "./sync-fixture"
import {
  emitCreated,
  emitDeleted,
  emitMessage,
  emitPart,
  emitRow,
  fetchFor,
  row,
  userMessage,
  withSessionLimit,
} from "./root-eviction-fixture"
import { forgetInboundChild, inboundChildRank, noteInboundMessage } from "../../../../src/routes/session/child-inbound"
import type { FetchHandler } from "../../../fixture/tui-sdk"

const deferredFetch = (
  rows: Map<string, ReturnType<typeof row>>,
  calls: Map<string, number>,
): { handler: FetchHandler; resolveSession: (sessionID: string, info: ReturnType<typeof row> | undefined) => void } => {
  const pending = new Map<string, ((info: ReturnType<typeof row> | undefined) => void)[]>()
  return {
    handler: (url: URL) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (!session || session[1] !== "ses_slow") return fetchFor(rows, calls)(url)
      const sessionID = session[1]
      calls.set(sessionID, (calls.get(sessionID) ?? 0) + 1)
      return new Promise<Response>((resolve) => {
        const list = pending.get(sessionID) ?? []
        list.push((info) => resolve(info ? json(info) : new Response("not found", { status: 404 })))
        pending.set(sessionID, list)
      })
    },
    resolveSession: (sessionID, info) => {
      const list = pending.get(sessionID) ?? []
      pending.delete(sessionID)
      for (const resolve of list) resolve(info)
    },
  }
}

test("session.created inserts the child row so the conveyor can show it", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(fetchFor(new Map([[root.id, root]]), calls))

    try {
      emitRow(emit, root)
      emitCreated(emit, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === child.id)?.parentID).toBe(root.id)
      expect(calls.get(child.id) ?? 0).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a user message for a missing row reconciles it with exactly one GET per flight", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_slow", root.id)
    const rows = new Map([
      [root.id, root],
      [child.id, child],
    ])
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitMessage(emit, userMessage(child.id, 100))
      emitMessage(emit, userMessage(child.id, 101))
      await wait(() => (calls.get(child.id) ?? 0) === 1)
      resolveSession(child.id, child)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === child.id)?.parentID).toBe(root.id)
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a reconciliation GET proving the unknown session is a root clears its provisional rank", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const slowRoot = row("ses_slow")
    const rows = new Map([
      [root.id, root],
      [slowRoot.id, slowRoot],
    ])
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      forgetInboundChild(slowRoot.id)
      emitRow(emit, root)
      emitMessage(emit, userMessage(slowRoot.id, 100))
      await wait(() => (calls.get(slowRoot.id) ?? 0) === 1)
      expect(inboundChildRank(slowRoot.id)?.at).toBe(100)
      resolveSession(slowRoot.id, slowRoot)
      await wait(() => sync.data.session.find((session) => session.id === slowRoot.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === slowRoot.id)?.parentID).toBeUndefined()
      expect(inboundChildRank(slowRoot.id)).toBeUndefined()
    } finally {
      forgetInboundChild(slowRoot.id)
      app.renderer.destroy()
    }
  })
})

test("a session event arriving during the GET wins over the GET result", async () => {
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
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitMessage(emit, userMessage("ses_slow", 100))
      await wait(() => (calls.get("ses_slow") ?? 0) === 1)
      emitRow(emit, eventRow)
      await wait(() => sync.data.session.find((session) => session.id === "ses_slow")?.title === "from-event")
      resolveSession("ses_slow", getRow)
      const drain = row("ses_drain", root.id)
      rows.set(drain.id, drain)
      emitMessage(emit, userMessage(drain.id, 100))
      await wait(() => sync.data.session.find((session) => session.id === drain.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === "ses_slow")?.title).toBe("from-event")
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a session deleted while the GET is in flight never gains a row", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const gone = row("ses_slow", root.id)
    const rows = new Map([
      [root.id, root],
      [gone.id, gone],
    ])
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      emitRow(emit, root)
      emitMessage(emit, userMessage(gone.id, 100))
      await wait(() => (calls.get(gone.id) ?? 0) === 1)
      emitDeleted(emit, gone)
      resolveSession(gone.id, gone)
      const drain = row("ses_drain", root.id)
      rows.set(drain.id, drain)
      emitMessage(emit, userMessage(drain.id, 100))
      await wait(() => sync.data.session.find((session) => session.id === drain.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === gone.id)).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})

test("a 404 reconciliation logs the failure and inserts nothing", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const missing = row("ses_slow", root.id)
    const rows = new Map([[root.id, root]])
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const { app, emit, sync } = await mount(handler, tmp.path)
    const errorLog = spyOn(console, "error").mockImplementation(() => {})

    try {
      emitRow(emit, root)
      emitMessage(emit, userMessage(missing.id, 100))
      await wait(() => (calls.get(missing.id) ?? 0) === 1)
      resolveSession(missing.id, undefined)
      await wait(() => errorLog.mock.calls.length > 0)
      expect(sync.data.session.find((session) => session.id === missing.id)).toBeUndefined()
      expect(errorLog.mock.calls[0]?.[0]).toBe("tui session row reconciliation failed")
    } finally {
      errorLog.mockRestore()
      app.renderer.destroy()
    }
  })
})

test("message.part.updated alone never triggers a reconciliation GET", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(
      fetchFor(
        new Map([
          [root.id, root],
          [child.id, child],
        ]),
        calls,
      ),
    )

    try {
      emitRow(emit, root)
      emitPart(emit, child.id)
      const drain = row("ses_drain", root.id)
      emitMessage(emit, userMessage(drain.id, 100))
      await wait(() => sync.data.session.find((session) => session.id === drain.id) !== undefined)
      expect(calls.get(child.id) ?? 0).toBe(0)
      expect(sync.data.session.find((session) => session.id === child.id)).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})

test("an unknown-session user message keeps its provisional rank until a root row proves otherwise", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const root = row("ses_root")
    const child = row("ses_child", root.id)
    const calls = new Map<string, number>()
    const { app, emit, sync } = await mount(
      fetchFor(
        new Map([
          [root.id, root],
          [child.id, child],
        ]),
        calls,
      ),
    )

    try {
      forgetInboundChild(child.id)
      emitRow(emit, root)
      emitMessage(emit, userMessage(child.id, 100))
      await wait(() => (calls.get(child.id) ?? 0) === 1)
      await wait(() => sync.data.session.find((session) => session.id === child.id) !== undefined)
      expect(inboundChildRank(child.id)?.at).toBe(100)
      emitRow(emit, { ...root, title: "root-reupserted" })
      await wait(() => sync.data.session.find((session) => session.id === root.id)?.title === "root-reupserted")
      expect(inboundChildRank(root.id)).toBeUndefined()
      expect(inboundChildRank(child.id)?.at).toBe(100)
    } finally {
      forgetInboundChild(child.id)
      app.renderer.destroy()
    }
  })
})

test("hydrating a root through session.sync clears its provisional inbound rank", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const slowRoot = row("ses_slow")
    const rows = new Map([[slowRoot.id, slowRoot]])
    const calls = new Map<string, number>()
    const sessionGets = new Map<string, number>()
    const pending = new Map<string, ((info: ReturnType<typeof row> | undefined) => void)[]>()
    const handler: FetchHandler = (url) => {
      const session = url.pathname.match(/^\/session\/([^/]+)$/)
      if (!session || session[1] !== "ses_slow") return fetchFor(rows, calls)(url)
      sessionGets.set("ses_slow", (sessionGets.get("ses_slow") ?? 0) + 1)
      return new Promise<Response>((resolve) => {
        const list = pending.get("ses_slow") ?? []
        list.push((info) => resolve(info ? json(info) : new Response("not found", { status: 404 })))
        pending.set("ses_slow", list)
      })
    }
    const { app, emit, sync } = await mount(handler, tmp.path)

    try {
      forgetInboundChild(slowRoot.id)
      noteInboundMessage(userMessage(slowRoot.id, 100))
      expect(inboundChildRank(slowRoot.id)?.at).toBe(100)
      void sync.session.sync(slowRoot.id)
      await wait(() => (sessionGets.get("ses_slow") ?? 0) === 1)
      for (const resolve of pending.get("ses_slow") ?? []) resolve(slowRoot)
      await wait(() => sync.data.session.find((session) => session.id === slowRoot.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === slowRoot.id)?.parentID).toBeUndefined()
      expect(inboundChildRank(slowRoot.id)).toBeUndefined()
    } finally {
      forgetInboundChild(slowRoot.id)
      app.renderer.destroy()
    }
  })
})

test("a session list refresh clears provisional ranks of roots it reconciles", async () => {
  await withSessionLimit("50", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const lateRoot = row("ses_slow")
    const rows = new Map<string, ReturnType<typeof row>>()
    const calls = new Map<string, number>()
    const { handler, resolveSession } = deferredFetch(rows, calls)
    const listHandler: FetchHandler = (url) => {
      if (url.pathname === "/session") return json([...rows.values()])
      return handler(url)
    }
    const { app, emit, sync } = await mount(listHandler, tmp.path)

    try {
      forgetInboundChild(lateRoot.id)
      await wait(() => sync.data.status === "complete")
      rows.set(lateRoot.id, lateRoot)
      emitMessage(emit, userMessage(lateRoot.id, 100))
      await wait(() => (calls.get(lateRoot.id) ?? 0) === 1)
      expect(inboundChildRank(lateRoot.id)?.at).toBe(100)
      await sync.session.refresh()
      await wait(() => sync.data.session.find((session) => session.id === lateRoot.id) !== undefined)
      expect(sync.data.session.find((session) => session.id === lateRoot.id)?.parentID).toBeUndefined()
      expect(inboundChildRank(lateRoot.id)).toBeUndefined()
      resolveSession(lateRoot.id, lateRoot)
    } finally {
      forgetInboundChild(lateRoot.id)
      app.renderer.destroy()
    }
  })
})
