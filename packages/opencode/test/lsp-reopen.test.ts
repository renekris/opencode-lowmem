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
const openDocuments = new Map()
const noDiagnostics = process.env.FAKE_LSP_NO_DIAGNOSTICS === "1"

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

function diagnosticsFor(uri) {
  const text = openDocuments.get(uri)
  if (text === undefined) return []
  return [{
    message: "analyzed:" + text,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }]
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
  if (message.method === "test/diagnostics") {
    respond(message.id, diagnosticsFor(message.params.uri))
    return
  }
  if (message.method === "test/references") {
    respond(message.id, openDocuments.has(message.params.uri) ? [{ uri: message.params.uri }] : [])
    return
  }
  if (message.method === "test/publish") {
    notify("textDocument/publishDiagnostics", {
      ...message.params,
      diagnostics: openDocuments.has(message.params.uri) ? message.params.diagnostics : [],
    })
    respond(message.id, null)
    return
  }
  if (message.method === "textDocument/didOpen") {
    openDocuments.set(message.params.textDocument.uri, message.params.textDocument.text)
    events.push({ method: message.method, params: message.params })
    if (!noDiagnostics) {
      notify("textDocument/publishDiagnostics", {
        uri: message.params.textDocument.uri,
        version: message.params.textDocument.version,
        diagnostics: diagnosticsFor(message.params.textDocument.uri),
      })
    }
    return
  }
  if (message.method === "textDocument/didChange") {
    const changes = message.params.contentChanges
    openDocuments.set(message.params.textDocument.uri, changes.at(-1).text)
    events.push({ method: message.method, params: message.params })
    return
  }
  if (message.method === "textDocument/didClose") {
    openDocuments.delete(message.params.textDocument.uri)
    events.push({ method: message.method, params: message.params })
    return
  }
  if (message.method === "workspace/didChangeWatchedFiles") {
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

async function waitForEventCount(client: LSPClient.Info, count: number) {
  const startedAt = performance.now()
  while (performance.now() - startedAt < 1_000) {
    const events = await eventsFor(client)
    if (events.length >= count) return events
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} fake LSP events`)
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

function spawnFakeServer(serverPath: string, noDiagnostics = false): LSPServer.Handle {
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
      env: { ...process.env, FAKE_LSP_NO_DIAGNOSTICS: noDiagnostics ? "1" : "0" },
    }),
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
            const initialEvents = await waitForEventCount(client, 2)
            expect(initialEvents.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didClose",
            ])
            expect(client.diagnostics.get(file)?.[0]?.message).toBe("analyzed:" + "x".repeat(2_049))

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

  test("does not serialize a normal open behind an oversized no-push close", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        await Bun.write(path.join(directory, "large.ts"), "x".repeat(2_049))
        await Bun.write(path.join(directory, "normal.ts"), "normal\n")
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
              server: spawnFakeServer(tmp.extra, true),
              root: tmp.path,
              directory: tmp.path,
              instance: ctx,
            })
            const large = path.join(tmp.path, "large.ts")
            const normal = path.join(tmp.path, "normal.ts")

            const oversizedOpening = client.notify.open({ path: large })
            const startedAt = performance.now()
            await client.notify.open({ path: normal })
            expect(performance.now() - startedAt).toBeLessThan(2_500)

            const beforeClose = await eventsFor(client)
            expect(beforeClose.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didOpen",
            ])

            await Bun.sleep(3_100)
            await oversizedOpening
            const afterClose = await eventsFor(client)
            expect(afterClose.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didOpen",
              "textDocument/didClose",
            ])

            await Bun.write(large, "small\n")
            await client.notify.open({ path: large })
            const reopened = await eventsFor(client)
            expect(reopened.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didOpen",
              "textDocument/didClose",
              "textDocument/didOpen",
            ])
            expect(reopened.at(-1)?.params?.textDocument?.text).toBe("small\n")
            await client.shutdown()
          },
        }),
    )
  }, { timeout: 15_000 })

  test("discards a delayed oversized close after a fresh reopen", async () => {
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
              server: spawnFakeServer(tmp.extra, true),
              root: tmp.path,
              directory: tmp.path,
              instance: ctx,
            })
            const large = path.join(tmp.path, "large.ts")

            const firstOpening = client.notify.open({ path: large })
            const firstEvents = await waitForEventCount(client, 1)
            expect(firstEvents.map((event) => event.method)).toEqual(["textDocument/didOpen"])

            await Bun.write(large, "small\n")
            const startedAt = performance.now()
            await client.notify.open({ path: large })
            expect(performance.now() - startedAt).toBeLessThan(2_500)
            await firstOpening

            await Bun.sleep(3_100)
            const events = await eventsFor(client)
            expect(events.map((event) => event.method)).toEqual([
              "textDocument/didOpen",
              "textDocument/didClose",
              "textDocument/didOpen",
            ])
            expect(events.at(-1)?.params?.textDocument?.text).toBe("small\n")
            await client.shutdown()
          },
        }),
    )
  }, { timeout: 15_000 })

  test("bounds close tombstones during repeated LRU eviction", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        for (const name of ["one.ts", "two.ts", "three.ts", "four.ts"]) {
          await Bun.write(path.join(directory, name), name)
        }
        return serverPath
      },
    })

    await withLimits(
      {
        OPENCODE_LSP_DOC_LIMIT: "2",
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

            for (const name of ["one.ts", "two.ts", "three.ts", "four.ts"]) {
              await client.notify.open({ path: path.join(tmp.path, name) })
            }

            expect(client.documentStats.closedDocuments).toBeLessThanOrEqual(2)
            await client.shutdown()
          },
        }),
    )
  }, { timeout: 15_000 })

  test("re-analyzes a document after LRU eviction discards server state", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        const serverPath = path.join(directory, "fake-lsp-server.js")
        await Bun.write(serverPath, SERVER)
        await Bun.write(path.join(directory, "first.ts"), "first\n")
        await Bun.write(path.join(directory, "second.ts"), "second\n")
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
            const firstUri = pathToFileURL(first).href

            await client.notify.open({ path: first })
            await client.connection.sendRequest("test/diagnostics", { uri: firstUri })
            expect(client.diagnostics.get(first)?.[0]?.message).toBe("analyzed:first\n")

            await client.notify.open({ path: second })
            expect(await client.connection.sendRequest<unknown[]>("test/diagnostics", { uri: firstUri })).toEqual([])
            expect(await client.connection.sendRequest<unknown[]>("test/references", { uri: firstUri })).toEqual([])
            expect(client.diagnostics.has(first)).toBe(false)

            await client.notify.open({ path: first })
            await client.connection.sendRequest("test/diagnostics", { uri: firstUri })
            expect(client.diagnostics.get(first)?.[0]?.message).toBe("analyzed:first\n")
            expect(await client.connection.sendRequest<unknown[]>("test/references", { uri: firstUri })).toEqual([
              { uri: firstUri },
            ])

            const events = await eventsFor(client)
            expect(
              events
                .filter((event) => event.method === "textDocument/didOpen")
                .map((event) => event.params?.textDocument?.text),
            ).toEqual(["first\n", "second\n", "first\n"])
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
