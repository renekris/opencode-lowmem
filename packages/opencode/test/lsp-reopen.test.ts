import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "path"
import { pathToFileURL } from "url"
import { LSPClient } from "@/lsp/client"
import type * as LSPServer from "@/lsp/server"
import { Filesystem } from "@/util/filesystem"
import { tmpdir, withTestInstance } from "./fixture/fixture"

const SERVER = String.raw`
let buffer = Buffer.alloc(0)
let nextId = 1
const events = []

function encode(message) {
  const json = JSON.stringify(message)
  return Buffer.from("Content-Length: " + Buffer.byteLength(json, "utf8") + "\r\n\r\n" + json, "utf8")
}

function send(message) {
  process.stdout.write(encode(message))
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params })
}

function handle(message) {
  if (message.method === "initialize") {
    respond(message.id, { capabilities: { textDocumentSync: { change: 2 } } })
    return
  }
  if (message.method === "test/events") {
    respond(message.id, events)
    return
  }
  if (message.method === "test/publish") {
    notify("textDocument/publishDiagnostics", message.params)
    respond(message.id, null)
    return
  }
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange" || message.method === "textDocument/didClose" || message.method === "workspace/didChangeWatchedFiles") {
    events.push({ method: message.method, params: message.params })
    return
  }
  if (message.id !== undefined) respond(message.id, null)
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n")
    if (separator < 0) break
    const header = buffer.slice(0, separator).toString("utf8")
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) break
    const length = Number.parseInt(match[1], 10)
    const start = separator + 4
    const end = start + length
    if (buffer.length < end) break
    const message = JSON.parse(buffer.slice(start, end).toString("utf8"))
    buffer = buffer.slice(end)
    handle(message)
  }
})
`

type ServerEvent = {
  readonly method: string
  readonly params?: {
    readonly textDocument?: {
      readonly uri: string
      readonly version: number
      readonly text?: string
    }
  }
}

function eventsFor(client: LSPClient.Info) {
  return client.connection.sendRequest<ServerEvent[]>("test/events", {})
}

async function withLimits<T>(values: Record<string, string>, action: () => Promise<T>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    return await action()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function spawnFakeServer(serverPath: string): LSPServer.Handle {
  return {
    process: spawn(process.execPath, [serverPath], { stdio: "pipe" }),
  }
}

describe("LSP document reopen behavior", () => {
  test("uses didOpen as the authoritative transition and discards closed diagnostics", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        await Bun.write(path.join(directory, "first.ts"), "one\n")
        await Bun.write(path.join(directory, "second.ts"), "two\n")
        return serverPath
      },
    })

    await withLimits(
      {
        OPENCODE_LSP_DOC_LIMIT: "1",
        OPENCODE_LSP_DOC_MAX_MB: "64MB",
        OPENCODE_LSP_DOC_OPEN_ALLOWANCE_MB: "2KB",
      },
      async () =>
        withTestInstance({
          directory: tmp.path,
          fn: async (ctx) => {
            const client = await LSPClient.create({
              serverID: "fake",
              server: spawnFakeServer(tmp.extra),
              root: tmp.path,
              directory: tmp.path,
              instance: ctx,
            })
            const first = path.join(tmp.path, "first.ts")
            const second = path.join(tmp.path, "second.ts")

            await client.notify.open({ path: first })
            await Bun.write(first, "first\nsecond\n")
            await client.notify.open({ path: first })
            await client.notify.open({ path: second })
            const evictedEvents = await eventsFor(client)

            expect(evictedEvents.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didChange",
              "textDocument/didClose",
              "textDocument/didOpen",
            ])
            expect(evictedEvents.some((event) => event.method === "workspace/didChangeWatchedFiles")).toBe(false)

            await client.connection.sendRequest("test/publish", {
              uri: pathToFileURL(first).href,
              version: 0,
              diagnostics: [{ message: "late closed diagnostic" }],
            })
            expect(client.diagnostics.has(first)).toBe(false)

            await client.notify.open({ path: first })
            await client.connection.sendRequest("test/publish", {
              uri: pathToFileURL(first).href,
              version: 0,
              diagnostics: [{ message: "reopened diagnostic" }],
            })
            expect(client.diagnostics.get(first)?.[0]?.message).toBe("reopened diagnostic")
            await client.shutdown()
          },
        }),
    )
  }, { timeout: 15_000 })

  test("refreshes an oversized metadata-only document with didClose and full didOpen", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        await Bun.write(path.join(directory, "large.ts"), "x".repeat(2_049))
        return serverPath
      },
    })

    await withLimits(
      {
        OPENCODE_LSP_DOC_LIMIT: "128",
        OPENCODE_LSP_DOC_MAX_MB: "64MB",
        OPENCODE_LSP_DOC_OPEN_ALLOWANCE_MB: "2KB",
      },
      async () =>
        withTestInstance({
          directory: tmp.path,
          fn: async (ctx) => {
            const client = await LSPClient.create({
              serverID: "fake",
              server: spawnFakeServer(tmp.extra),
              root: tmp.path,
              directory: tmp.path,
              instance: ctx,
            })
            const file = path.join(tmp.path, "large.ts")
            await client.notify.open({ path: file })
            await Bun.write(file, "small\n")
            await client.notify.open({ path: file })
            const events = await eventsFor(client)

            expect(events.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didClose",
              "textDocument/didOpen",
            ])
            expect(events[0]?.params?.textDocument?.text).toHaveLength(2_049)
            expect(events[2]?.params?.textDocument?.text).toBe("small\n")
            expect(events.some((event) => event.method === "workspace/didChangeWatchedFiles")).toBe(false)
            await client.shutdown()
          },
        }),
    )
  }, { timeout: 15_000 })

  test("concurrent opens keep a single in-flight file read", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        const names = ["one.ts", "two.ts", "three.ts", "four.ts"]
        for (const [index, name] of names.entries())
          await Bun.write(path.join(directory, name), `body ${index}\n`)
        return serverPath
      },
    })

    await withTestInstance({
      directory: tmp.path,
      fn: async (ctx) => {
        let active = 0
        let maxActive = 0
        const client = await LSPClient.create({
          serverID: "fake",
          server: spawnFakeServer(tmp.extra),
          root: tmp.path,
          directory: tmp.path,
          instance: ctx,
          readFile: async (filePath) => {
            active++
            maxActive = Math.max(maxActive, active)
            const text = await Filesystem.readText(filePath)
            active--
            return text
          },
        })
        const names = ["one.ts", "two.ts", "three.ts", "four.ts"]
        await Promise.all(names.map((name) => client.notify.open({ path: path.join(tmp.path, name) })))

        expect(maxActive).toBe(1)
        const events = await eventsFor(client)
        expect(events.filter((event) => event.method === "textDocument/didOpen")).toHaveLength(4)
        await client.shutdown()
      },
    })
  }, { timeout: 15_000 })
})
