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
  let now = 0

  const controlledSetTimeout = (callback: TimerCallback, delay?: number): TimerHandle => {
    const handle = originalSetTimeout(() => undefined, 0)
    originalClearTimeout(handle)
    timers.set(handle, {
      callback: typeof callback === "function" ? () => callback() : () => undefined,
      due: now + (delay ?? 0),
    })
    return handle
  }

  Object.defineProperty(globalThis, "setTimeout", { value: controlledSetTimeout, writable: true })
  Object.defineProperty(globalThis, "clearTimeout", {
    value: (handle: TimerHandle) => timers.delete(handle),
    writable: true,
  })

  return {
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

function emitMutation(events: ReturnType<typeof createEventSource>, sessionID: string, messageID: string) {
  events.emit(
    global({
      id: `evt_${messageID}`,
      type: "session.next.context.updated",
      properties: { sessionID, messageID, timestamp: 0, text: sessionID },
    }),
  )
}

test("Given A B A mutations, when C arrives, then the least-recently touched B session is evicted", async () => {
  const restoreLimit = setEnv("OPENCODE_TUI_MIRROR_SESSION_LIMIT", "2")
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
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
  const timers = controlTimers()

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  try {
    await mounted
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    emitMutation(events, "ses_a", "msg_a_0")
    emitMutation(events, "ses_b", "msg_b_0")
    emitMutation(events, "ses_a", "msg_a_1")
    timers.advance(16)
    timers.advance(120)
    emitMutation(events, "ses_c", "msg_c_0")
    timers.advance(16)
    timers.advance(120)

    expect(data.session.message.list("ses_a")).toHaveLength(2)
    expect(data.session.message.list("ses_b")).toBeUndefined()
    expect(data.session.message.list("ses_c")).toHaveLength(1)
  } finally {
    timers.restore()
    app.renderer.destroy()
    restoreLimit()
  }
})

test("Given queued B and refreshed A, when C arrives, then refresh remains the newest recency barrier", async () => {
  const restoreLimit = setEnv("OPENCODE_TUI_MIRROR_SESSION_LIMIT", "2")
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_a/message") return json({ data: [assistant("msg_a", "authoritative")] })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
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
  const timers = controlTimers()

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  try {
    await mounted
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    emitMutation(events, "ses_b", "msg_b")
    timers.advance(16)
    await data.session.message.refresh("ses_a")
    emitMutation(events, "ses_c", "msg_c")
    timers.advance(16)
    timers.advance(120)

    expect(data.session.message.list("ses_a")).toEqual([assistant("msg_a", "authoritative")])
    expect(data.session.message.list("ses_b")).toBeUndefined()
    expect(data.session.message.list("ses_c")).toHaveLength(1)
  } finally {
    timers.restore()
    app.renderer.destroy()
    restoreLimit()
  }
})
