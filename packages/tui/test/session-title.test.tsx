import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

// Fork(lowmem): the terminal title carries the session id so it stays visible
// in tmux pane titles without opening /debug. Opt out with
// OPENCODE_TUI_SESSION_ID_IN_TITLE=0.

const session = {
  id: "ses_title_1234",
  title: "Demo session",
  slug: "demo-session",
  projectID: "project",
  directory,
  version: "0.0.0-test",
  time: { created: 0, updated: 0 },
}

async function startApp(titles: string[]) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/session/status") return json([])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: { sessionID: session.id },
      pluginHost: {
        async start(input) {
          api = input.api
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  return {
    setup,
    task,
    ready,
    get api() {
      return api
    },
  }
}

test("terminal title includes the session id by default", async () => {
  const titles: string[] = []
  const app = await startApp(titles)
  try {
    await app.ready
    await app.setup.renderOnce()
    await app.setup.renderOnce()
    expect(titles.some((title) => title.includes("ses_title_1234"))).toBe(true)
    expect(titles.some((title) => title.startsWith("OC | Demo session"))).toBe(true)
  } finally {
    if (!app.setup.renderer.isDestroyed) app.setup.renderer.destroy()
    mock.restore()
  }
})

test("OPENCODE_TUI_SESSION_ID_IN_TITLE=0 hides the id from the title", async () => {
  const titles: string[] = []
  process.env.OPENCODE_TUI_SESSION_ID_IN_TITLE = "0"
  const app = await startApp(titles)
  try {
    await app.ready
    await app.setup.renderOnce()
    await app.setup.renderOnce()
    expect(titles.some((title) => title.includes("ses_title_1234"))).toBe(false)
    expect(titles.some((title) => title.startsWith("OC | Demo session"))).toBe(true)
  } finally {
    delete process.env.OPENCODE_TUI_SESSION_ID_IN_TITLE
    if (!app.setup.renderer.isDestroyed) app.setup.renderer.destroy()
    mock.restore()
  }
})
