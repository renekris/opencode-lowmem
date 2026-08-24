/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Event, GlobalEvent, SessionMessage } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { testRender } from "@opentui/solid"
import { DataProvider, useData } from "../src/context/data"
import { ProjectProvider } from "../src/context/project"
import { RouteProvider } from "../src/context/route"
import { SDKProvider } from "../src/context/sdk"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import { wait } from "./cli/cmd/tui/sync-fixture"

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function assistant(id: string, text: string): SessionMessage {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test" },
    content: [{ type: "text", id: `${id}_text`, text }],
    time: { created: 0, completed: 1 },
  }
}

function setEnv(name: string, value: string) {
  const previous = process.env[name]
  process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test("bounds event updates and the refresh bypass with whole message records", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_refresh/message")
      return json({ data: [assistant("msg_refresh", "x".repeat(600_000))] })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <RouteProvider initialRoute={{ type: "home" }}>
        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
          <ProjectProvider>
            <DataProvider>
              <Probe />
            </DataProvider>
          </ProjectProvider>
        </SDKProvider>
      </RouteProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    events.emit(
      global({
        id: "evt_oversized",
        type: "session.next.context.updated",
        properties: {
          sessionID: "ses_event",
          messageID: "msg_event",
          timestamp: 0,
          text: "x".repeat(600_000),
        },
      }),
    )
    await wait(() => data.session.message.list("ses_event") !== undefined)
    expect(data.session.message.list("ses_event")).toEqual([])

    await data.session.message.refresh("ses_refresh")
    expect(data.session.message.list("ses_refresh")).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the active mirror record while evicting the next-LRU background record", async () => {
  const restoreLimit = setEnv("OPENCODE_TUI_MIRROR_SESSION_LIMIT", "2")
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <RouteProvider initialRoute={{ type: "session", sessionID: "ses_active" }}>
        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
          <ProjectProvider>
            <DataProvider>
              <Probe />
            </DataProvider>
          </ProjectProvider>
        </SDKProvider>
      </RouteProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const emitUpdate = (sessionID: string, messageID: string) =>
      events.emit(
        global({
          id: `evt_${messageID}`,
          type: "session.next.context.updated",
          properties: { sessionID, messageID, timestamp: 0, text: sessionID },
        }),
      )

    emitUpdate("ses_active", "msg_active")
    emitUpdate("ses_background_0", "msg_background_0")
    emitUpdate("ses_background_1", "msg_background_1")
    await wait(() => data.session.message.list("ses_background_1") !== undefined)

    expect(data.session.message.list("ses_active")).toHaveLength(1)
    expect(data.session.message.list("ses_background_0")).toBeUndefined()
    expect(data.session.message.list("ses_background_1")).toHaveLength(1)
  } finally {
    app.renderer.destroy()
    restoreLimit()
  }
})

test("stops at an all-active mirror budget and warns without looping", async () => {
  const restoreBudget = setEnv("OPENCODE_TUI_MIRROR_BUDGET_MB", "1MB")
  const restoreMessageMax = setEnv("OPENCODE_TUI_MIRROR_MSG_MAX_KB", "1024KB")
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <RouteProvider initialRoute={{ type: "session", sessionID: "ses_active" }}>
        <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
          <ProjectProvider>
            <DataProvider>
              <Probe />
            </DataProvider>
          </ProjectProvider>
        </SDKProvider>
      </RouteProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    events.emit(
      global({
        id: "evt_active_0",
        type: "session.next.context.updated",
        properties: { sessionID: "ses_active", messageID: "msg_active_0", timestamp: 0, text: "x".repeat(600_000) },
      }),
    )
    events.emit(
      global({
        id: "evt_active_1",
        type: "session.next.context.updated",
        properties: { sessionID: "ses_active", messageID: "msg_active_1", timestamp: 0, text: "y".repeat(600_000) },
      }),
    )
    await wait(() => data.session.message.list("ses_active")?.length === 2)

    expect(data.session.message.list("ses_active")).toHaveLength(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[0]).toBe("tui data mirror pressure")
    expect(warnings[0]?.[1]).toMatchObject({
      protectedResident: expect.any(Number),
      protectedSessionCount: 1,
      protectedSessionIDs: ["ses_active"],
    })
  } finally {
    app.renderer.destroy()
    console.warn = originalWarn
    restoreMessageMax()
    restoreBudget()
  }
})
