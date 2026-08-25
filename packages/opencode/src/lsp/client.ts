import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"
import type { Diagnostic as VSCodeDiagnostic } from "vscode-languageserver-types"
import { Process } from "@/util/process"
import { LANGUAGE_EXTENSIONS } from "./language"
import { Schema } from "effect"
import type * as LSPServer from "./server"
import { withTimeout } from "../util/timeout"
import { Filesystem } from "@/util/filesystem"
import type { InstanceContext } from "@/project/instance-context"
import { DocumentStore } from "./document-store"
import { EnvLimit } from "@opencode-ai/core/util/env-limit"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
const OVERSIZED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3_000

const INITIALIZE_TIMEOUT_MS = 45_000

const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

const diagnosticMeasure = new TextEncoder()

export type Info = NonNullable<Awaited<ReturnType<typeof create>>>

export type Stats = DocumentStore.Stats & {
  readonly closedDocuments: number
}

export type Diagnostic = VSCodeDiagnostic

export class InitializeError extends Schema.TaggedErrorClass<InitializeError>()("LSPInitializeError", {
  serverID: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type PullDiagnosticEntry = {
  readonly diagnostics: Diagnostic[]
  readonly bytes: number
  readonly evictable: boolean
}

type DocumentGeneration = {
  readonly sequence: number
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

function getFilePath(uri: string) {
  if (!uri.startsWith("file://")) return
  return Filesystem.normalizePath(fileURLToPath(uri))
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

// TypeScript's built-in LSP pushes diagnostics aggressively on first open.
// We seed the push cache on the very first publish so waitForFreshPush can
// resolve immediately instead of waiting for a second debounced push.
function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

function assertNever(value: never): never {
  throw new Error(`Unexpected LSP document event: ${JSON.stringify(value)}`)
}

export async function create(input: {
  serverID: string
  server: LSPServer.Handle
  root: string
  directory: string
  instance: InstanceContext
  readFile?: (path: string) => Promise<string>
}) {
  const readFile = input.readFile ?? Filesystem.readText
  const connection = createMessageConnection(
    new StreamMessageReader(input.server.process.stdout as any),
    new StreamMessageWriter(input.server.process.stdin as any),
  )
  input.server.process.stderr?.resume()
  // --- Connection state ---

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, PullDiagnosticEntry>()
  const pullDiagnosticCountLimit = EnvLimit.readEnvLimit("OPENCODE_LSP_PULL_DIAGNOSTICS_LIMIT", "256", "count")
  const pullDiagnosticBytesLimit = EnvLimit.readEnvLimit("OPENCODE_LSP_PULL_DIAGNOSTICS_MAX_MB", "8MB", "bytes")
  let pullDiagnosticCount = 0
  let pullDiagnosticBytes = 0
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const documentGenerationListeners = new Set<() => void>()
  const closedDocuments = new Map<string, undefined>()
  const documentGenerations = new Map<string, DocumentGeneration>()
  let nextDocumentGeneration = 0
  const documents = DocumentStore.create()
  const closedDocumentLimit = documents.stats().documentLimit
  const beginDocumentGeneration = (documentPath: string) => {
    const generation = { sequence: ++nextDocumentGeneration }
    documentGenerations.set(documentPath, generation)
    return generation
  }
  const deletePullDiagnostics = (documentPath: string) => {
    const entry = pullDiagnostics.get(documentPath)
    if (!entry) return
    pullDiagnostics.delete(documentPath)
    if (!entry.evictable) return
    pullDiagnosticCount -= 1
    pullDiagnosticBytes -= entry.bytes
  }
  const enforcePullDiagnosticLimits = () => {
    while (
      (pullDiagnosticCountLimit > 0 && pullDiagnosticCount > pullDiagnosticCountLimit) ||
      (pullDiagnosticBytesLimit > 0 && pullDiagnosticBytes > pullDiagnosticBytesLimit)
    ) {
      let oldestPath: string | undefined
      for (const [documentPath, entry] of pullDiagnostics) {
        if (!entry.evictable || documents.has(documentPath)) continue
        oldestPath = documentPath
        break
      }
      if (oldestPath === undefined) return
      deletePullDiagnostics(oldestPath)
    }
  }
  const rememberClosedDocument = (documentPath: string) => {
    if (closedDocumentLimit <= 0) return
    closedDocuments.delete(documentPath)
    closedDocuments.set(documentPath, undefined)
    while (closedDocuments.size > closedDocumentLimit) {
      const oldest = closedDocuments.keys().next().value
      if (oldest === undefined) return
      closedDocuments.delete(oldest)
    }
  }
  documents.onEvict(async ({ path: documentPath }) => {
    documentGenerations.delete(documentPath)
    const alreadyClosed = closedDocuments.delete(documentPath)
    if (!alreadyClosed) {
      await connection.sendNotification("textDocument/didClose", {
        textDocument: {
          uri: pathToFileURL(documentPath).href,
        },
      })
    }
    pushDiagnostics.delete(documentPath)
    deletePullDiagnostics(documentPath)
    published.delete(documentPath)
    rememberClosedDocument(documentPath)
    for (const listener of [...documentGenerationListeners]) listener()
  })
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([
      ...(pushDiagnostics.get(filePath) ?? []),
      ...(pullDiagnostics.get(filePath)?.diagnostics ?? []),
    ])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    if (!documents.has(filePath)) return
    pushDiagnostics.set(filePath, next)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    if (skipsPullDiagnostics(filePath)) return
    deletePullDiagnostics(filePath)
    const evictable = !documents.has(filePath)
    const entry = {
      diagnostics: next,
      bytes: diagnosticMeasure.encode(JSON.stringify(next)).byteLength,
      evictable,
    }
    pullDiagnostics.set(filePath, entry)
    if (evictable) {
      pullDiagnosticCount += 1
      pullDiagnosticBytes += entry.bytes
      enforcePullDiagnosticLimits()
    }
  }
  // Pull results cover files the server knows about, including never-opened
  // workspace files; only server-side-closed documents (tombstoned evictions
  // and metadata-only oversized entries) must not receive stale results.
  const skipsPullDiagnostics = (filePath: string) =>
    closedDocuments.has(filePath) || (documents.has(filePath) && !documents.hasFull(filePath))
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  // --- LSP connection handlers ---

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const filePath = getFilePath(params.uri)
    if (!filePath) return
    if (!documents.has(filePath)) return
    published.set(filePath, {
      at: Date.now(),
      version: typeof params.version === "number" ? params.version : undefined,
    })
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, params.diagnostics)
      return
    }
    updatePushDiagnostics(filePath, params.diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", () => {
    return null
  })
  connection.onRequest("workspace/configuration", async (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", async (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("client/unregisterCapability", async (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
  })
  connection.onRequest("workspace/workspaceFolders", async () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", async () => null)
  connection.listen()

  // --- Initialize handshake ---

  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    throw new InitializeError({ serverID: input.serverID, cause: err })
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  await connection.sendNotification("initialized", {})

  if (input.server.initialization) {
    await connection.sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  // --- Diagnostic helpers ---

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      if (skipsPullDiagnostics(target)) continue
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = getFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? getFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  // LATENCY-CRITICAL: dispatch identifier pulls in parallel and unblock once one
  // batch already produced diagnostics for the current file. Let slower pulls keep
  // merging in the background; do not sequence identifier-by-identifier, and do
  // not add a post-match settle/debounce delay. See PR #23771.
  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      let generationUnsub: (() => void) | undefined
      const generation = documents.generation
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        generationUnsub?.()
        resolve(result)
      }
      const schedule = () => {
        if (documents.generation !== generation) {
          finish(false)
          return
        }
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      const generationListener = () => finish(false)
      documentGenerationListeners.add(generationListener)
      generationUnsub = () => documentGenerationListeners.delete(generationListener)
      schedule()
    })
  }

  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  // --- Public API ---

  const result = {
    root: input.root,
    get serverID() {
      return input.serverID
    },
    get connection() {
      return connection
    },
    notify: {
      async open(request: { path: string }) {
        const normalizedPath = Filesystem.normalizePath(
          path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
        )
        const extension = path.extname(normalizedPath)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"
        let oversizedOpen:
          | {
              readonly version: number
              readonly after: number
              readonly generation: DocumentGeneration
            }
          | undefined
        const document = await documents.open(normalizedPath, () => readFile(normalizedPath), async (event) => {
          switch (event.kind) {
            case "change":
              // Do not wipe diagnostics on didChange. Some servers (e.g. clangd) only
              // re-emit diagnostics when the content actually changes, so clearing
              // here would lose errors for no-op touchFile calls. Let the server's
              // next push/pull overwrite naturally.
              await connection.sendNotification("textDocument/didChange", {
                textDocument: {
                  uri: pathToFileURL(normalizedPath).href,
                  version: event.document.version,
                },
                contentChanges:
                  syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                    ? [
                        {
                          range: {
                            start: { line: 0, character: 0 },
                            end: endPosition(event.previous.text),
                          },
                          text: event.text,
                        },
                      ]
                    : [{ text: event.text }],
              })
              return
            case "open": {
              closedDocuments.delete(normalizedPath)
              pushDiagnostics.delete(normalizedPath)
              deletePullDiagnostics(normalizedPath)
              const documentGeneration = beginDocumentGeneration(normalizedPath)
              const diagnosticsStartedAt = Date.now()
              await connection.sendNotification("textDocument/didOpen", {
                textDocument: {
                  uri: pathToFileURL(normalizedPath).href,
                  languageId,
                  version: event.document.version,
                  text: event.text,
                },
              })
              if (event.document.metadataOnly)
                oversizedOpen = {
                  version: event.document.version,
                  after: diagnosticsStartedAt,
                  generation: documentGeneration,
                }
              return
            }
            default:
              return assertNever(event)
          }
        })
        if (oversizedOpen) {
          const pendingClose = oversizedOpen
          void (async () => {
            await waitForFreshPush({
              path: normalizedPath,
              version: pendingClose.version,
              after: pendingClose.after,
              timeout: OVERSIZED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
            })
            if (documentGenerations.get(normalizedPath) !== pendingClose.generation) return
            rememberClosedDocument(normalizedPath)
            await connection.sendNotification("textDocument/didClose", {
              textDocument: {
                uri: pathToFileURL(normalizedPath).href,
              },
            })
          })()
        }
        return document.version
      },
    },
    get diagnostics() {
      const result = new Map<string, Diagnostic[]>()
      for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        result.set(key, mergedDiagnostics(key))
      }
      return result
    },
    get documentStats(): Stats {
      return { ...documents.stats(), closedDocuments: closedDocuments.size }
    },
    async waitForDiagnostics(request: { path: string; version: number; mode?: "document" | "full"; after?: number }) {
      const normalizedPath = Filesystem.normalizePath(
        path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path),
      )
      if (!documents.has(normalizedPath)) return
      if (request.mode === "document") {
        await waitForDocumentDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
        return
      }
      await waitForFullDiagnostics({ path: normalizedPath, version: request.version, after: request.after })
    },
    async shutdown() {
      await documents.closeAll()
      connection.end()
      connection.dispose()
      await Process.stop(input.server.process)
    },
  }

  return result
}

export * as LSPClient from "./client"
