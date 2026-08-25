import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir, withTestInstance } from "../fixture/fixture"
import { LSPClient } from "@/lsp/client"
import type * as LSPServer from "@/lsp/server"

function spawnFakeServer(): LSPServer.Handle {
  const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
  return {
    process: spawn(process.execPath, [serverPath], {
      stdio: "pipe",
    }),
  }
}

async function withPullDiagnosticLimits(
  limits: { readonly count: string; readonly bytes: string },
  fn: () => Promise<void>,
) {
  const previousCount = process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT
  const previousBytes = process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB
  process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT = limits.count
  process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB = limits.bytes
  try {
    await fn()
  } finally {
    if (previousCount === undefined) delete process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT
    else process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT = previousCount
    if (previousBytes === undefined) delete process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB
    else process.env.OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB = previousBytes
  }
}

describe("LSPClient pull diagnostic bounds", () => {
  test("bounds unopened pull diagnostics by count without evicting resident diagnostics", async () => {
    await withPullDiagnosticLimits({ count: "2", bytes: "0" }, async () => {
      const handle = spawnFakeServer()
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "client.cs")
      const related = ["one", "two", "three"].map((name) => path.join(tmp.path, `${name}.cs`))
      await Bun.write(file, "class C {}\n")
      for (const relatedFile of related) await Bun.write(relatedFile, "class D {}\n")

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const client = await LSPClient.create({
            serverID: "fake",
            server: handle,
            root: tmp.path,
            directory: tmp.path,
            instance: ctx,
          })

          await client.connection.sendRequest("test/configure-pull-diagnostics", {
            registerOn: "didOpen",
            registrations: [{ identifier: "DocumentCompilerSemantic" }, { identifier: "workspace", workspaceDiagnostics: true }],
            documentDiagnostics: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 5 },
                },
                message: "resident diagnostic",
                severity: 1,
              },
            ],
            workspaceDiagnostics: related.map((relatedFile, index) => ({
              uri: pathToFileURL(relatedFile).href,
              items: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                  },
                  message: `workspace diagnostic ${index}`,
                  severity: 1,
                },
              ],
            })),
          })

          const version = await client.notify.open({ path: file })
          await client.waitForDiagnostics({ path: file, version, mode: "full" })

          expect(client.diagnostics.get(file)?.[0]?.message).toBe("resident diagnostic")
          expect(client.diagnostics.has(related[0])).toBe(false)
          expect(client.diagnostics.get(related[1])?.[0]?.message).toBe("workspace diagnostic 1")
          expect(client.diagnostics.get(related[2])?.[0]?.message).toBe("workspace diagnostic 2")

          await client.shutdown()
        },
      })
    })
  })

  test("bounds unopened pull diagnostics by bytes", async () => {
    await withPullDiagnosticLimits({ count: "0", bytes: "1KB" }, async () => {
      const handle = spawnFakeServer()
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "client.cs")
      const related = ["one", "two"].map((name) => path.join(tmp.path, `${name}.cs`))
      await Bun.write(file, "class C {}\n")
      for (const relatedFile of related) await Bun.write(relatedFile, "class D {}\n")

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const client = await LSPClient.create({
            serverID: "fake",
            server: handle,
            root: tmp.path,
            directory: tmp.path,
            instance: ctx,
          })

          await client.connection.sendRequest("test/configure-pull-diagnostics", {
            registerOn: "didOpen",
            registrations: [{ identifier: "workspace", workspaceDiagnostics: true }],
            workspaceDiagnostics: related.map((relatedFile, index) => ({
              uri: pathToFileURL(relatedFile).href,
              items: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 5 },
                  },
                  message: `${"x".repeat(500)} ${index}`,
                  severity: 1,
                },
              ],
            })),
          })

          const version = await client.notify.open({ path: file })
          await client.waitForDiagnostics({ path: file, version, mode: "full" })

          expect(client.diagnostics.has(related[0])).toBe(false)
          expect(client.diagnostics.get(related[1])?.[0]?.message).toContain(" 1")

          await client.shutdown()
        },
      })
    })
  })

  test("measures pull diagnostic pressure in utf-8 bytes, not utf-16 units", async () => {
    await withPullDiagnosticLimits({ count: "0", bytes: "1KB" }, async () => {
      const handle = spawnFakeServer()
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "client.cs")
      const related = path.join(tmp.path, "related.cs")
      await Bun.write(file, "class C {}\n")
      await Bun.write(related, "class D {}\n")

      await withTestInstance({
        directory: tmp.path,
        fn: async (ctx) => {
          const client = await LSPClient.create({
            serverID: "fake",
            server: handle,
            root: tmp.path,
            directory: tmp.path,
            instance: ctx,
          })

          // 400 astral characters measure under the 1KB cap in utf-16 units
          // (800 + wrapper) but over it in utf-8 bytes (1600 + wrapper).
          const message = "😀".repeat(400)
          await client.connection.sendRequest("test/configure-pull-diagnostics", {
            registerOn: "didOpen",
            registrations: [{ identifier: "DocumentCompilerSemantic" }, { identifier: "workspace", workspaceDiagnostics: true }],
            documentDiagnostics: [],
            workspaceDiagnostics: [
              {
                uri: pathToFileURL(related).href,
                items: [
                  {
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 5 },
                    },
                    message,
                    severity: 1,
                  },
                ],
              },
            ],
          })

          const version = await client.notify.open({ path: file })
          await client.waitForDiagnostics({ path: file, version, mode: "full" })

          expect(client.diagnostics.has(related)).toBe(false)

          await client.shutdown()
        },
      })
    })
  })
})
