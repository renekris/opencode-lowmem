/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { join } from "node:path"
import { tmpdir } from "./fixture/fixture"
import { json, mount } from "./cli/cmd/tui/sync-fixture"

const childMode = process.env.OPENCODE_TUI_NO_REVIVAL_CHILD === "1"

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

function message(sessionID: string, index: number) {
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
    structured: { payload: "x".repeat(300_000) },
    time: { created: index, completed: index + 1 },
  }
}

test("does not revive evicted children until explicit activation", async () => {
  if (!childMode) {
    const child = Bun.spawn([process.execPath, "test", "test/no-revival.test.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_TUI_NO_REVIVAL_CHILD: "1",
        OPENCODE_TUI_PAYLOAD_BUDGET_MB: "8MB",
        OPENCODE_TUI_PAYLOAD_SESSION_LIMIT: "5",
        OPENCODE_TUI_PART_INGRESS_MAX_KB: "64KB",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    return
  }

  expect(process.env.OPENCODE_TUI_PAYLOAD_BUDGET_MB).toBe("8MB")
  expect(process.env.OPENCODE_TUI_PAYLOAD_SESSION_LIMIT).toBe("5")
  expect(process.env.OPENCODE_TUI_PART_INGRESS_MAX_KB).toBe("64KB")

  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const calls = new Map<string, number>()
  const { app, emit, sync } = await mount((url) => {
    const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/)
    const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    const todoMatch = url.pathname.match(/^\/session\/([^/]+)\/todo$/)
    const diffMatch = url.pathname.match(/^\/session\/([^/]+)\/diff$/)
    const sessionID = sessionMatch?.[1] ?? messageMatch?.[1] ?? todoMatch?.[1] ?? diffMatch?.[1]
    if (!sessionID) return
    calls.set(sessionID, (calls.get(sessionID) ?? 0) + 1)
    if (sessionMatch) return json(row(sessionID))
    if (messageMatch) return json([{ info: message(sessionID, 0), parts: [] }])
    return json([])
  }, tmp.path)

  try {
    const children = Array.from({ length: 50 }, (_, index) => `ses_child_${String(index + 1).padStart(2, "0")}`)
    for (const sessionID of children) await sync.session.sync(sessionID)
    expect(children.every((sessionID) => calls.get(sessionID) === 4)).toBe(true)

    const active = "ses_child_51"
    sync.session.activate(active)
    await sync.session.sync(active)
    expect(calls.get(active)).toBe(4)
    expect(sync.payload.stats().evictions).toBeGreaterThan(0)
    expect(sync.payload.stats().evictableSessionCount).toBeLessThanOrEqual(5)
    expect(children.some((sessionID) => sync.session.isEvicted(sessionID))).toBe(true)

    const beforeEvents = new Map(calls)
    const emittedEvents = new Map<string, number>()
    const emitPayload = (sessionID: string) => {
      const messageID = `msg_${sessionID}_late`
      emit(
        global({
          id: `evt_message_${sessionID}`,
          type: "message.updated",
          properties: { sessionID, info: { ...message(sessionID, 99), id: messageID, time: { created: 99 } } },
        }),
      )
      for (let index = 0; index < 3; index++)
        emit(
          global({
            id: `evt_delta_${sessionID}_${index}`,
            type: "message.part.delta",
            properties: { sessionID, messageID, partID: `prt_${messageID}`, field: "text", delta: "late" },
          }),
        )
      emittedEvents.set(sessionID, (emittedEvents.get(sessionID) ?? 0) + 4)
    }

    for (const sessionID of children) emitPayload(sessionID)
    expect(children.every((sessionID) => emittedEvents.get(sessionID) === 4)).toBe(true)
    expect([...calls.entries()].filter(([id, count]) => count !== beforeEvents.get(id)).length).toBe(0)

    const target = children[0]
    if (target === undefined) throw new Error("missing child fixture")
    sync.session.activate(target)
    await sync.session.sync(target)
    expect(calls.get(target)).toBe((beforeEvents.get(target) ?? 0) + 4)
    expect(sync.data.message[target]?.[0]).toMatchObject({ structured: { payload: "x".repeat(300_000) } })
    const afterActivation = new Map(calls)

    for (const sessionID of children.slice(1)) emitPayload(sessionID)
    expect(emittedEvents.get(target)).toBe(4)
    expect(children.slice(1).every((sessionID) => emittedEvents.get(sessionID) === 8)).toBe(true)
    expect(calls).toEqual(afterActivation)
  } finally {
    app.renderer.destroy()
  }
})
