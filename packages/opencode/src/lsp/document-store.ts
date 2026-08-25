import path from "path"
import { Filesystem } from "@/util/filesystem"
import { EnvLimit } from "@/util/env-limit"

export type FullDocument = {
  readonly path: string
  readonly version: number
  readonly text: string
  readonly byteLength: number
  readonly metadataOnly: false
}

export type MetadataDocument = {
  readonly path: string
  readonly version: number
  readonly byteLength: number
  readonly metadataOnly: true
}

export type Document = FullDocument | MetadataDocument

export type EvictedDocument = {
  readonly path: string
  readonly document: Document
}

export type OpenEvent =
  | {
      readonly kind: "open"
      readonly document: Document
      readonly text: string
    }
  | {
      readonly kind: "change"
      readonly document: FullDocument
      readonly previous: FullDocument
      readonly text: string
    }

export type OpenHandler = (event: OpenEvent) => Promise<void> | void

export type Stats = {
  readonly documentLimit: number
  readonly count: number
  readonly bytes: number
  readonly metadataOnly: number
  readonly openingCount: number
  readonly openingBytes: number
}

type StoredDocument = {
  document: Document
  state: "opening" | "open" | "evicting"
}

type Options = {
  readonly documentLimit?: number
  readonly documentMaxBytes?: number
  readonly documentOpenAllowanceBytes?: number
  readonly oversizedDocumentLimit?: number
  readonly warn?: WarningHandler
}

type EvictListener = (document: EvictedDocument) => Promise<void> | void
type PressureWarning = {
  readonly component: "opencode.lsp.document-store"
  readonly budget: "OPENCODE_LSP_DOC_LIMIT / OPENCODE_LSP_DOC_MAX_MB"
  readonly evictableResident: number
  readonly protectedResident: 0
  readonly count: number
  readonly bytes: number
  readonly evictions: number
  readonly truncations: 0
  readonly documentPath: string
  readonly action: "evict"
}
type WarningHandler = (message: string, data: PressureWarning) => void

export type Interface = {
  readonly open: (
    path: string,
    source: string | (() => Promise<string>),
    handler?: OpenHandler,
  ) => Promise<Document>
  readonly touch: (path: string) => Promise<Document | undefined>
  readonly get: (path: string) => Document | undefined
  readonly has: (path: string) => boolean
  readonly hasFull: (path: string) => boolean
  readonly isOversized: (text: string) => boolean
  readonly onEvict: (listener: EvictListener) => () => void
  readonly closeAll: () => Promise<void>
  readonly stats: () => Stats
  readonly getGeneration: () => number
  readonly generation: number
}

export function create(options: Options = {}): Interface {
  const documentLimit =
    options.documentLimit ?? EnvLimit.readEnvLimit("OPENCODE_LSP_DOC_LIMIT", "128", "count")
  const documentMaxBytes =
    options.documentMaxBytes ?? EnvLimit.readEnvLimit("OPENCODE_LSP_DOC_MAX_MB", "64MB", "bytes")
  const documentOpenAllowanceBytes =
    options.documentOpenAllowanceBytes ??
    EnvLimit.readEnvLimit("OPENCODE_LSP_DOC_OPEN_ALLOWANCE_MB", "32MB", "bytes")
  const oversizedDocumentLimit =
    options.oversizedDocumentLimit ?? EnvLimit.readEnvLimit("OPENCODE_LSP_OVERSIZED_LIMIT", "8", "count")
  const documents = new Map<string, StoredDocument>()
  const listeners = new Set<EvictListener>()
  const serial = new Map<string, Promise<void>>()
  let openSerial = Promise.resolve()
  const warn: WarningHandler =
    options.warn ?? ((message, data) => console.warn(message, data))
  let generation = 0
  let evictions = 0
  let lastWarningAt = Number.NEGATIVE_INFINITY

  const normalize = (documentPath: string) => Filesystem.normalizePath(path.resolve(documentPath))
  const byteLength = (text: string) => new TextEncoder().encode(text).byteLength
  const isOversized = (text: string) => {
    const bytes = byteLength(text)
    return (
      (documentOpenAllowanceBytes > 0 && bytes > documentOpenAllowanceBytes) ||
      (documentMaxBytes > 0 && bytes > documentMaxBytes)
    )
  }
  const runSerialized = async <T>(documentPath: string, action: () => Promise<T>) => {
    const previous = serial.get(documentPath) ?? Promise.resolve()
    const current = previous.then(action)
    const finished = current.then(
      () => undefined,
      () => undefined,
    )
    serial.set(documentPath, finished)
    try {
      return await current
    } finally {
      if (serial.get(documentPath) === finished) serial.delete(documentPath)
    }
  }
  const runOpenSerialized = async <T>(action: () => Promise<T>) => {
    const previous = openSerial
    const current = previous.then(action)
    openSerial = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }
  const stats = (): Stats => {
    let count = 0
    let bytes = 0
    let metadataOnly = 0
    let openingCount = 0
    let openingBytes = 0
    for (const item of documents.values()) {
      if (item.state === "evicting") continue
      if (item.document.metadataOnly) {
        metadataOnly++
        continue
      }
      if (item.state === "opening") {
        openingCount++
        openingBytes += item.document.byteLength
        continue
      }
      count++
      bytes += item.document.byteLength
    }
    return { documentLimit, count, bytes, metadataOnly, openingCount, openingBytes }
  }
  const evict = async (documentPath: string, item: StoredDocument) => {
    if (item.state === "evicting") return false
    item.state = "evicting"
    const event = { path: documentPath, document: item.document }
    for (const listener of [...listeners]) await listener(event)
    if (documents.get(documentPath) !== item) return false
    documents.delete(documentPath)
    generation++
    return true
  }
  const reportPressure = (documentPath: string) => {
    const now = Date.now()
    if (now - lastWarningAt < 60_000) return
    lastWarningAt = now
    const current = stats()
    warn("lsp document store pressure", {
      component: "opencode.lsp.document-store",
      budget: "OPENCODE_LSP_DOC_LIMIT / OPENCODE_LSP_DOC_MAX_MB",
      evictableResident: current.bytes,
      protectedResident: 0,
      count: current.count,
      bytes: current.bytes,
      evictions,
      truncations: 0,
      documentPath,
      action: "evict",
    })
  }
  const enforce = async (protectedPath: string, opening?: Document) => {
    while (true) {
      const current = stats()
      const openingCount = opening?.metadataOnly === false ? 1 : 0
      const openingBytes = opening?.metadataOnly === false ? opening.byteLength : 0
      const overCount = documentLimit > 0 && current.count + openingCount > documentLimit
      const overBytes = documentMaxBytes > 0 && current.bytes + openingBytes > documentMaxBytes
      const overOversized = oversizedDocumentLimit > 0 && current.metadataOnly > oversizedDocumentLimit
      if (!overCount && !overBytes && !overOversized) return
      const candidates = [...documents.entries()]
      const candidate =
        overCount || overBytes
          ? candidates.find(
              ([documentPath, item]) =>
                documentPath !== protectedPath && item.state === "open" && !item.document.metadataOnly,
            )
          : undefined
      const oversizedCandidate = overOversized
        ? candidates.find(
            ([documentPath, item]) =>
              documentPath !== protectedPath && item.state === "open" && item.document.metadataOnly,
          )
        : undefined
      const selected = candidate ?? oversizedCandidate
      if (!selected) return
      const didEvict = await runSerialized(selected[0], () => evict(selected[0], selected[1]))
      if (!didEvict) continue
      evictions++
      reportPressure(selected[0])
    }
  }
  const open = async (
    documentPath: string,
    source: string | (() => Promise<string>),
    handler?: OpenHandler,
  ) => {
    const normalizedPath = normalize(documentPath)
    // Lock order: global open turn outermost, per-path innermost. touch/closeAll
    // take per-path locks without ever awaiting the open turn, so this order is
    // cycle-free; the reverse order deadlocks via enforce() awaiting an eviction
    // candidate whose own open is queued behind this turn.
    return runOpenSerialized(() =>
      runSerialized(normalizedPath, async () => {
        // Load inside the global turn: queued opens hold only the loader, never a
        // second resident copy of the text (plan's single in-flight read residual).
        const text = typeof source === "function" ? await source() : source
        const existing = documents.get(normalizedPath)
        const oversized = isOversized(text)
        const reopen = existing !== undefined && (existing.document.metadataOnly || oversized)
        if (reopen && existing) await evict(normalizedPath, existing)

        const previous = reopen ? undefined : existing?.document
        const version = previous?.version === undefined ? 0 : previous.version + 1
        const document: Document = oversized
          ? { path: normalizedPath, version, byteLength: byteLength(text), metadataOnly: true }
          : { path: normalizedPath, version, text, byteLength: byteLength(text), metadataOnly: false }
        const item: StoredDocument = { document, state: "opening" }
        if (existing && !reopen) documents.delete(normalizedPath)
        documents.set(normalizedPath, item)
        await enforce(normalizedPath, document)

        if (handler) {
          if (previous?.metadataOnly === false && document.metadataOnly === false && !reopen && !oversized) {
            await handler({ kind: "change", document, previous, text })
          } else {
            await handler({ kind: "open", document, text })
          }
        }
        item.state = "open"
        await enforce(normalizedPath)
        return document
      }),
    )
  }
  const touch = async (documentPath: string) => {
    const normalizedPath = normalize(documentPath)
    return runSerialized(normalizedPath, async () => {
      const item = documents.get(normalizedPath)
      if (!item) return undefined
      if (item.document.metadataOnly) {
        await evict(normalizedPath, item)
        return undefined
      }
      if (item.state === "open") {
        documents.delete(normalizedPath)
        documents.set(normalizedPath, item)
      }
      return item.document
    })
  }
  const get = (documentPath: string) => {
    const normalizedPath = normalize(documentPath)
    const item = documents.get(normalizedPath)
    if (!item) return undefined
    if (item.state === "open") {
      documents.delete(normalizedPath)
      documents.set(normalizedPath, item)
    }
    return item.document
  }
  const has = (documentPath: string) => documents.has(normalize(documentPath))
  const hasFull = (documentPath: string) => {
    const item = documents.get(normalize(documentPath))
    return item?.state === "open" && item.document.metadataOnly === false
  }
  const onEvict = (listener: EvictListener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const closeAll = async () => {
    for (const [documentPath, item] of [...documents.entries()]) {
      await runSerialized(documentPath, () => evict(documentPath, item))
    }
  }

  return {
    open,
    touch,
    get,
    has,
    hasFull,
    isOversized,
    onEvict,
    closeAll,
    stats,
    getGeneration: () => generation,
    get generation() {
      return generation
    },
  }
}

export * as DocumentStore from "./document-store"
