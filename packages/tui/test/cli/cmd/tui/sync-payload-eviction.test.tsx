/** @jsxImportSource @opentui/solid */
import { inboundChildRank } from "../../../../src/routes/session/child-inbound"
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { stateApi } from "../../../../src/plugin/adapters"
import { json, mount, wait } from "./sync-fixture"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function row(id: string) {
  return {
    id,
    title: id,
    slug: id,
    projectID: "proj_test",
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
  }
}

function terminalMessage(sessionID: string, index: number) {
  return {
    id: `msg_${sessionID}_${index}`,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: `msg_${sessionID}_user_${index}`,
    path: { cwd: "/tmp/opencode/packages/opencode", root: "/tmp/opencode/packages/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index, completed: index + 1 },
  }
}

function fetchFor() {
  return (url: URL) => {
    const session = url.pathname.match(/^\/session\/([^/]+)$/)
    if (session) return json(row(session[1]))
    const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (messages) {
      const id = messages[1]
      return json([{ info: terminalMessage(id, 0), parts: [] }])
    }
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
    return undefined
  }
}

async function seed(emit: (event: GlobalEvent) => void, prefix: string, count: number) {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_${String(index).padStart(2, "0")}`)
  for (const id of ids)
    emit(global({ id: `evt_row_${id}`, type: "session.updated", properties: { sessionID: id, info: row(id) } }))
  for (const id of ids)
    emit(
      global({
        id: `evt_msg_${id}`,
        type: "message.updated",
        properties: { sessionID: id, info: terminalMessage(id, 0) },
      }),
    )
  return ids
}

function pushExtra(emit: (event: GlobalEvent) => void, suffix: string) {
  const id = `ses_extra_${suffix}`
  emit(
    global({
      id: `evt_msg_${id}`,
      type: "message.updated",
      properties: { sessionID: id, info: terminalMessage(id, 0) },
    }),
  )
}

test("compaction evicts least-recently-viewed terminal sessions and keeps rows", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_seed", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    await sync.session.sync(ids[0])
    await sync.session.sync(ids[1])
    await sync.session.sync(ids[2])
    pushExtra(emit, "1")
    pushExtra(emit, "2")
    await wait(() => sync.data.message["ses_extra_2"]?.length === 1)

    expect(sync.data.message["ses_seed_03"]).toBeUndefined()
    expect(sync.data.message["ses_seed_04"]).toBeUndefined()
    expect(sync.data.message[ids[0]]).toHaveLength(1)
    expect(sync.data.message[ids[1]]).toHaveLength(1)
    expect(sync.data.message[ids[2]]).toHaveLength(1)
    expect(sync.data.message["ses_seed_05"]).toHaveLength(1)
    expect(sync.data.message["ses_extra_1"]).toHaveLength(1)
    expect(sync.data.part["msg_ses_seed_03_0"]).toBeUndefined()
    expect(sync.data.session.filter((session) => session.id.startsWith("ses_"))).toHaveLength(20)
  } finally {
    app.renderer.destroy()
  }
})

test("running sessions are never evicted", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_run", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    emit(
      global({
        id: "evt_status_busy",
        type: "session.status",
        properties: { sessionID: ids[3], status: { type: "busy" } },
      }),
    )
    pushExtra(emit, "1")
    pushExtra(emit, "2")
    await wait(() => sync.data.message["ses_extra_2"]?.length === 1)

    expect(sync.data.message[ids[3]]).toHaveLength(1)
    expect(sync.data.message["ses_run_00"]).toBeUndefined()
    expect(sync.data.message["ses_run_01"]).toBeUndefined()
    expect(sync.data.message["ses_run_02"]).toHaveLength(1)
    expect(sync.data.message["ses_run_04"]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("sessions with pending permissions are never evicted", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_perm", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    emit(
      global({
        id: "evt_permission",
        type: "permission.asked",
        properties: {
          id: "per_pending",
          sessionID: ids[3],
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      }),
    )
    pushExtra(emit, "1")
    pushExtra(emit, "2")
    await wait(() => sync.data.message["ses_extra_2"]?.length === 1)

    expect(sync.data.message[ids[3]]).toHaveLength(1)
    expect(sync.data.message["ses_perm_00"]).toBeUndefined()
    expect(sync.data.message["ses_perm_01"]).toBeUndefined()
    expect(sync.data.message["ses_perm_02"]).toHaveLength(1)
    expect(sync.data.permission[ids[3]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("orphan part updates do not resurrect evicted sessions", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_orphan", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    pushExtra(emit, "1")
    await wait(() => sync.data.message[ids[0]] === undefined)

    emit(
      global({
        id: "evt_part_resurrect",
        type: "message.part.updated",
        properties: {
          sessionID: ids[0],
          time: 1,
          part: {
            id: "prt_orphan",
            sessionID: ids[0],
            messageID: `msg_${ids[0]}_0`,
            type: "text",
            text: "resurrected",
          },
        },
      }),
    )
    await Bun.sleep(100)
    expect(sync.data.part[`msg_${ids[0]}_0`]).toBeUndefined()
    expect(sync.data.message[ids[0]]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("re-entering an evicted session re-hydrates its payload", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const target = "ses_rehydrate"
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_rehy", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    pushExtra(emit, "1")
    await wait(() => sync.data.message[ids[0]] === undefined)

    await sync.session.sync(target)
    expect(sync.data.message[target]).toHaveLength(1)

    emit(
      global({
        id: "evt_part_after_revive",
        type: "message.part.updated",
        properties: {
          sessionID: target,
          time: 1,
          part: {
            id: "prt_revived",
            sessionID: target,
            messageID: `msg_${target}_0`,
            type: "text",
            text: "live again",
          },
        },
      }),
    )
    await wait(() => sync.data.part[`msg_${target}_0`]?.[0] !== undefined)
    expect(sync.data.part[`msg_${target}_0`][0]).toMatchObject({ text: "live again" })
  } finally {
    app.renderer.destroy()
  }
})

test("protected oldest sessions do not block eviction of later excess", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_scan", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    emit(
      global({ id: "evt_busy_1", type: "session.status", properties: { sessionID: ids[0], status: { type: "busy" } } }),
    )
    emit(
      global({ id: "evt_busy_2", type: "session.status", properties: { sessionID: ids[1], status: { type: "busy" } } }),
    )
    pushExtra(emit, "1")
    pushExtra(emit, "2")
    await wait(() => sync.data.message["ses_extra_2"]?.length === 1)

    expect(sync.data.message[ids[0]]).toHaveLength(1)
    expect(sync.data.message[ids[1]]).toHaveLength(1)
    expect(sync.data.message[ids[2]]).toBeUndefined()
    expect(sync.data.message[ids[3]]).toBeUndefined()
    expect(sync.data.message[ids[4]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("hydration alone compacts payloads without global message events", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = Array.from({ length: 30 }, (_, index) => `ses_hydrate_${String(index).padStart(2, "0")}`)
    for (const id of ids) await sync.session.sync(id)

    const retained = ids.filter((id) => sync.data.message[id] !== undefined)
    expect(retained.length).toBeLessThanOrEqual(20)
    expect(sync.data.message[ids[0]]).toBeUndefined()
    expect(sync.data.message[ids[29]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("the activated route session survives child preview syncs", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_route", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    sync.session.activate(ids[0])
    for (const id of ids.slice(1, 20)) await sync.session.sync(id)
    await sync.session.sync("ses_child_preview")
    await wait(() => sync.data.message[ids[1]] === undefined)
    pushExtra(emit, "1")
    pushExtra(emit, "2")
    await Bun.sleep(150)

    expect(sync.data.message[ids[0]]).toHaveLength(1)
    expect(sync.data.message["ses_child_preview"]).toHaveLength(1)
    expect(sync.data.message[ids[2]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("eviction reclaims part buckets orphaned by message removal", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_orphan_bucket", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))

    const orphanMessage = `msg_${ids[0]}_0`
    emit(
      global({
        id: "evt_part_before_removal",
        type: "message.part.updated",
        properties: {
          sessionID: ids[0],
          time: 1,
          part: { id: "prt_orphaned", sessionID: ids[0], messageID: orphanMessage, type: "text", text: "kept" },
        },
      }),
    )
    emit(
      global({
        id: "evt_msg_removed",
        type: "message.removed",
        properties: { sessionID: ids[0], messageID: orphanMessage },
      }),
    )
    await wait(() => sync.data.message[ids[0]]?.length === 0)
    expect(sync.data.part[orphanMessage]).toHaveLength(1)

    pushExtra(emit, "1")
    await wait(() => sync.data.message[ids[0]] === undefined)
    expect(sync.data.part[orphanMessage]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("protection lifting compacts without new session buckets", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = Array.from({ length: 25 }, (_, index) => `ses_lift_${String(index).padStart(2, "0")}`)
    for (const id of ids)
      emit(global({ id: `evt_row_${id}`, type: "session.updated", properties: { sessionID: id, info: row(id) } }))
    for (const id of ids)
      emit(
        global({
          id: `evt_busy_${id}`,
          type: "session.status",
          properties: { sessionID: id, status: { type: "busy" } },
        }),
      )
    for (const id of ids)
      emit(
        global({
          id: `evt_msg_${id}`,
          type: "message.updated",
          properties: { sessionID: id, info: terminalMessage(id, 0) },
        }),
      )
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    expect(ids.filter((id) => sync.data.message[id] !== undefined).length).toBe(25)

    for (const id of ids)
      emit(
        global({
          id: `evt_idle_${id}`,
          type: "session.status",
          properties: { sessionID: id, status: { type: "idle" } },
        }),
      )
    await wait(() => ids.filter((id) => sync.data.message[id] !== undefined).length <= 20)

    expect(ids.filter((id) => sync.data.message[id] !== undefined).length).toBe(20)
    expect(sync.data.message[ids[24]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("activity on an evicted session revives its payloads", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_revive", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    pushExtra(emit, "1")
    await wait(() => sync.data.message[ids[0]] === undefined)

    const userMessage = {
      id: `msg_${ids[0]}_user`,
      sessionID: ids[0],
      role: "user" as const,
      time: { created: 99 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }
    emit(
      global({ id: "evt_revive_user", type: "message.updated", properties: { sessionID: ids[0], info: userMessage } }),
    )
    await wait(() => sync.data.message[ids[0]]?.length === 1)

    expect(sync.data.message[ids[0]]).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("streams deltas through the coalescing buffer", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_delta", 3)
    const sid = ids[0]!
    const mid = `msg_${sid}_a0`
    emit(
      global({
        id: "evt_delta_row",
        type: "session.updated",
        properties: { sessionID: sid, info: row(sid) },
      }),
    )
    emit(
      global({
        id: "evt_delta_msg",
        type: "message.updated",
        properties: {
          sessionID: sid,
          info: {
            id: mid,
            sessionID: sid,
            role: "assistant" as const,
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta_part",
        type: "message.part.updated",
        properties: {
          sessionID: sid,
          time: 2,
          part: { id: `part_${mid}_t`, messageID: mid, sessionID: sid, type: "text", text: "" },
        },
      }),
    )
    await wait(() => (sync.data.part[mid]?.length ?? 0) === 1)
    emit(
      global({
        id: "evt_delta_d1",
        type: "message.part.delta",
        properties: { sessionID: sid, messageID: mid, partID: `part_${mid}_t`, field: "text", delta: "hel" },
      }),
    )
    emit(
      global({
        id: "evt_delta_d2",
        type: "message.part.delta",
        properties: { sessionID: sid, messageID: mid, partID: `part_${mid}_t`, field: "text", delta: "lo" },
      }),
    )
    await wait(() => (sync.data.part[mid]?.[0] as { text?: string })?.text === "hello")
    expect((sync.data.part[mid]?.[0] as { text: string }).text).toBe("hello")
  } finally {
    app.renderer.destroy()
  }
})

test("session.deleted drops message and part buckets", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_gone", 3)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    const sid = ids[0]!
    const mid = `msg_${sid}_a0`
    emit(
      global({
        id: "evt_gone_del",
        type: "session.deleted",
        properties: { sessionID: sid, info: { id: sid } },
      }),
    )
    await wait(() => sync.data.session.find((x) => x.id === sid) === undefined)
    expect(sync.data.message[sid]).toBeUndefined()
    expect(sync.data.part[mid]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("root session user messages do not consume conveyor rank capacity", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit } = await mount(fetchFor(), tmp.path)

  try {
    const root = row("ses_root_a")
    emit(global({ id: "evt_root_row", type: "session.updated", properties: { sessionID: root.id, info: root } }))
    emit(
      global({
        id: "evt_root_msg",
        type: "message.updated",
        properties: {
          sessionID: root.id,
          info: {
            id: "msg_root_user",
            sessionID: root.id,
            role: "user" as const,
            time: { created: 99 },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          },
        },
      }),
    )
    await wait(() => inboundChildRank(root.id) === undefined && true)
    expect(inboundChildRank(root.id)).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("user messages for unknown sessions rank provisionally until a row proves them root", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit } = await mount(fetchFor(), tmp.path)

  try {
    const sid = "ses_mystery"
    emit(
      global({
        id: "evt_mystery_msg",
        type: "message.updated",
        properties: {
          sessionID: sid,
          info: {
            id: "msg_mystery_user",
            sessionID: sid,
            role: "user" as const,
            time: { created: 42 },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          },
        },
      }),
    )
    await wait(() => inboundChildRank(sid) !== undefined)
    expect(inboundChildRank(sid)).toBeDefined()

    const rootRow = row(sid)
    emit(global({ id: "evt_mystery_row", type: "session.updated", properties: { sessionID: sid, info: rootRow } }))
    await wait(() => inboundChildRank(sid) === undefined)
  } finally {
    app.renderer.destroy()
  }
})

test("legacy plugin payload getters refetch evicted session payloads", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_plugin", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    await sync.session.sync(ids[0])
    await sync.session.sync(ids[1])
    pushExtra(emit, "plugin")
    await wait(() => sync.data.message["ses_extra_plugin"]?.length === 1)
    expect(sync.data.message[ids[2]]).toBeUndefined()
    expect(sync.session.isEvicted(ids[2])).toBe(true)

    const state = stateApi(sync)
    expect(state.session.messages(ids[2])).toHaveLength(0)
    expect(sync.session.isEvicted(ids[2])).toBe(false)
    await wait(() => sync.data.message[ids[2]]?.length === 1)
  } finally {
    app.renderer.destroy()
  }
})

test("a failed revival re-arms the eviction gate for orphan parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const base = fetchFor()
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/ses_fail_00`) {
      return json({ error: "boom" }, { status: 500 })
    }
    return base(url)
  }, tmp.path)

  try {
    const ids = await seed(emit, "ses_fail", 20)
    await wait(() => ids.every((id) => sync.data.message[id]?.length === 1))
    await sync.session.sync(ids[1])
    await sync.session.sync(ids[2])
    pushExtra(emit, "fail")
    await wait(() => sync.data.message["ses_extra_fail"]?.length === 1)
    expect(sync.data.message[ids[0]]).toBeUndefined()
    expect(sync.session.isEvicted(ids[0])).toBe(true)

    emit(
      global({
        id: "evt_fail_revive_user",
        type: "message.updated",
        properties: {
          sessionID: ids[0],
          info: {
            id: `msg_${ids[0]}_user_revive`,
            sessionID: ids[0],
            role: "user" as const,
            agent: "build",
            model: { providerID: "test", modelID: "model" },
            time: { created: 50 },
          },
        },
      }),
    )
    await Bun.sleep(100)
    expect(sync.session.isEvicted(ids[0])).toBe(true)

    emit(
      global({
        id: "evt_fail_orphan_part",
        type: "message.part.updated",
        properties: {
          sessionID: ids[0],
          time: 60,
          part: {
            id: "part_fail_orphan",
            messageID: `msg_${ids[0]}_0`,
            sessionID: ids[0],
            type: "text" as const,
            text: "late",
          },
        },
      }),
    )
    await Bun.sleep(50)
    expect(sync.data.part[`msg_${ids[0]}_0`]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("message.part.removed for an unknown message does not throw", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(fetchFor(), tmp.path)

  try {
    const ids = await seed(emit, "ses_ghost", 1)
    await wait(() => sync.data.message[ids[0]]?.length === 1)

    emit(
      global({
        id: "evt_part_removed_unknown",
        type: "message.part.removed",
        properties: { sessionID: ids[0], messageID: "msg_never_seen", partID: "part_ghost" },
      }),
    )
    expect(sync.data.part["msg_never_seen"]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
