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

function controlTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  type TimerHandle = ReturnType<typeof originalSetTimeout>
  type TimerCallback = Parameters<typeof originalSetTimeout>[0]
  const timers = new Map<TimerHandle, { callback: () => void; due: number }>()
  let scheduledCount = 0
  let now = 0

  const controlledSetTimeout = (callback: TimerCallback, delay?: number): TimerHandle => {
    const handle = originalSetTimeout(() => undefined, 0)
    originalClearTimeout(handle)
    if (delay === 120) scheduledCount++
    timers.set(handle, {
      callback: typeof callback === "function" ? () => callback() : () => undefined,
      due: now + (delay ?? 0),
    })
    return handle
  }
  const controlledClearTimeout = (handle: TimerHandle) => {
    timers.delete(handle)
  }

  Object.defineProperty(globalThis, "setTimeout", { value: controlledSetTimeout, writable: true })
  Object.defineProperty(globalThis, "clearTimeout", { value: controlledClearTimeout, writable: true })

  return {
    scheduledCount() {
      return scheduledCount
    },
    advance(milliseconds: number) {
      const target = now + milliseconds
      while (true) {
        const next = [...timers.entries()].sort((left, right) => left[1].due - right[1].due)[0]
        if (!next || next[1].due > target) break
        timers.delete(next[0])
        now = next[1].due
        next[1].callback()
      }
      now = target
    },
    restore() {
      Object.defineProperty(globalThis, "setTimeout", { value: originalSetTimeout, writable: true })
      Object.defineProperty(globalThis, "clearTimeout", { value: originalClearTimeout, writable: true })
    },
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
  let timers: ReturnType<typeof controlTimers> | undefined
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
    timers = controlTimers()
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
    timers.advance(120)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(data.session.message.list("ses_event")).toEqual([])

    await data.session.message.refresh("ses_refresh")
    expect(data.session.message.list("ses_refresh")).toEqual([])
  } finally {
    timers?.restore()
    app.renderer.destroy()
  }
})

test("Given synchronous message mutations, when the mirror limit is exceeded, then eviction waits for one 120ms reconciliation", async () => {
  const restoreLimit = setEnv("OPENCODE_TUI_MIRROR_SESSION_LIMIT", "2")
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  let timers: ReturnType<typeof controlTimers> | undefined
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
    timers = controlTimers()

    const emitMutation = (sessionID: string, messageID: string) =>
      events.emit(
        global({
          id: `evt_${messageID}`,
          type: "session.next.context.updated",
          properties: { sessionID, messageID, timestamp: 0, text: sessionID },
        }),
      )

    emitMutation("ses_active", "msg_active")
    emitMutation("ses_background_0", "msg_background_0")
    emitMutation("ses_background_1", "msg_background_1")
    timers.advance(16)

    expect(data.session.message.list("ses_active")?.map((message) => message.id)).toEqual(["msg_active"])
    expect(data.session.message.list("ses_background_0")?.map((message) => message.id)).toEqual(["msg_background_0"])
    expect(data.session.message.list("ses_background_1")?.map((message) => message.id)).toEqual(["msg_background_1"])
    expect(timers.scheduledCount()).toBe(1)

    timers.advance(103)

    expect(data.session.message.list("ses_background_0")?.map((message) => message.id)).toEqual(["msg_background_0"])

    timers.advance(1)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(data.session.message.list("ses_active")?.map((message) => message.id)).toEqual(["msg_active"])
    expect(data.session.message.list("ses_background_0")).toBeUndefined()
    expect(data.session.message.list("ses_background_1")?.map((message) => message.id)).toEqual(["msg_background_1"])
  } finally {
    timers?.restore()
    app.renderer.destroy()
    restoreLimit()
  }
})

test("Given queued mutation work, when a full message refresh completes, then it stays immediate and authoritative", async () => {
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_refresh/message")
      return json({ data: [assistant("msg_authoritative", "authoritative")] })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  let timers: ReturnType<typeof controlTimers> | undefined
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
    timers = controlTimers()

    events.emit(
      global({
        id: "evt_stale_mutation",
        type: "session.next.context.updated",
        properties: {
          sessionID: "ses_refresh",
          messageID: "msg_stale",
          timestamp: 0,
          text: "stale mutation",
        },
      }),
    )
    expect(data.session.message.list("ses_refresh")?.map((message) => message.id)).toEqual(["msg_stale"])

    await data.session.message.refresh("ses_refresh")

    expect(data.session.message.list("ses_refresh")).toEqual([assistant("msg_authoritative", "authoritative")])

    timers.advance(120)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(data.session.message.list("ses_refresh")).toEqual([assistant("msg_authoritative", "authoritative")])
  } finally {
    timers?.restore()
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
  let timers: ReturnType<typeof controlTimers> | undefined
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
    timers = controlTimers()
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
    timers.advance(120)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(data.session.message.list("ses_active")).toHaveLength(1)
    expect(data.session.message.list("ses_background_0")).toBeUndefined()
    expect(data.session.message.list("ses_background_1")).toHaveLength(1)
  } finally {
    timers?.restore()
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
  let timers: ReturnType<typeof controlTimers> | undefined
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
    timers = controlTimers()
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
    timers.advance(120)
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(data.session.message.list("ses_active")).toHaveLength(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.[0]).toBe("tui data mirror pressure")
    expect(warnings[0]?.[1]).toMatchObject({
      protectedResident: expect.any(Number),
      protectedSessionCount: 1,
      protectedSessionIDs: ["ses_active"],
    })
  } finally {
    timers?.restore()
    app.renderer.destroy()
    console.warn = originalWarn
    restoreMessageMax()
    restoreBudget()
  }
})
