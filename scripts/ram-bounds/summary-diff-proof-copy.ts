import { lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises"
import { join, sep } from "node:path"
import type { CommandRunner } from "./summary-diff-proof-lib"

export class CopyBoundError extends Error {
  constructor(limitBytes: number) {
    super(`copy exceeded ${limitBytes} byte bound`)
  }
}

export async function pathExists(filename: string): Promise<boolean> {
  try {
    await stat(filename)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

// Transfer-bounded directory copy: symlink entries are skipped (never
// dereferenced), and the running total of copied file bytes may not exceed
// limitBytes, otherwise CopyBoundError aborts the candidate.
export async function copyBounded(source: string, destination: string, limitBytes: number): Promise<number> {
  const buffer = Buffer.alloc(transferChunkBytes)
  return await copyEntries(source, destination, 0, limitBytes, buffer)
}

const transferChunkBytes = 1024 * 1024

async function copyEntries(source: string, destination: string, transferred: number, limitBytes: number, buffer: Buffer): Promise<number> {
  let total = transferred
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      total = await copyEntries(from, to, total, limitBytes, buffer)
      continue
    }
    if (!entry.isFile()) continue
    total += await copyFileBounded(from, to, limitBytes - total, buffer)
  }
  return total
}

// Chunked copy that never writes more than the remaining allowance, so a
// source growing mid-copy cannot push peak disk usage past the bound; the
// one-byte probe distinguishes an exact fit from an over-budget source.
async function copyFileBounded(from: string, to: string, allowanceBytes: number, buffer: Buffer): Promise<number> {
  const source = await open(from, "r")
  const target = await open(to, "w")
  let written = 0
  try {
    while (true) {
      const allowance = allowanceBytes - written
      if (allowance <= 0) {
        if ((await source.read(buffer, 0, 1)).bytesRead > 0) throw new CopyBoundError(allowanceBytes)
        break
      }
      const { bytesRead } = await source.read(buffer, 0, Math.min(transferChunkBytes, allowance))
      if (bytesRead === 0) break
      const { bytesWritten } = await target.write(buffer, 0, bytesRead)
      if (bytesWritten !== bytesRead) throw new Error(`short write (${bytesWritten} of ${bytesRead} bytes) while copying ${from}`)
      written += bytesWritten
    }
  } finally {
    await source.close()
    await target.close()
  }
  return written
}

// Create the configured sandbox only under a canonicalized existing ancestor
// so a symlinked ancestor cannot redirect directory creation into the live
// data root before containment is checked.
export async function createUnderCanonicalAncestor(lexical: string): Promise<string> {
  const segments = lexical.split(sep).filter(Boolean)
  let existing: string = sep
  let index = 0
  while (index < segments.length) {
    const candidate = join(existing, segments[index])
    const info = await lstat(candidate).catch(() => undefined)
    if (!info) break
    if (info.isSymbolicLink()) throw new Error(`SANDBOX_XDG_DATA_HOME ancestor must not be a symlink: ${candidate}`)
    if (!info.isDirectory()) throw new Error(`SANDBOX_XDG_DATA_HOME ancestor is not a directory: ${candidate}`)
    existing = candidate
    index++
  }
  if (index < segments.length) await mkdir(lexical, { recursive: true })
  return await realpath(lexical)
}

// Snapshot storage borrows objects from the live repository through
// objects/info/alternates (snapshot/index.ts seed). Materialize the full
// object closure reachable from the needed snapshot hashes into the sandbox
// copy, remove the alternates link, then re-run the closure walk
// alternates-free so a missing blob anywhere in the reachability set fails
// loudly — no spawned git command can then touch the live object store. The
// pack is captured through pack-objects --stdout into the capped file writer:
// pack-objects is killed the moment the pack crosses the remaining bound, so
// a pathological pack can never land in full; the transient closure file is
// charged against the same bound and the index file is post-checked.
export type MaterializeResult = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly reason: string }

const closureCapBytes = 64 * 1024 * 1024

export async function materializeSnapshotObjects(input: {
  readonly gitDir: string
  readonly hashes: readonly string[]
  readonly limitBytes: number
  readonly runCommand: CommandRunner
}): Promise<MaterializeResult> {
  const alternates = join(input.gitDir, "objects", "info", "alternates")
  if (!(await pathExists(alternates))) return { ok: true, bytes: 0 }
  const environment = { PATH: process.env.PATH ?? "" }
  const list = ["git", `--git-dir=${input.gitDir}`, "rev-list", "--objects", ...input.hashes]
  const closureFile = join(input.gitDir, "proof-closure.tmp")
  const packDirectory = join(input.gitDir, "objects", "pack")
  const packTarget = join(packDirectory, "proof-materialized.pack")
  const packIndexTarget = join(packDirectory, "proof-materialized.idx")
  const packRevTarget = join(packDirectory, "proof-materialized.rev")
  // A refused candidate removes exactly what this step wrote, so no partial
  // artifacts survive it (the caller still removes the whole destination).
  const refuse = async (reason: string): Promise<MaterializeResult> => {
    await rm(packTarget, { force: true })
    await rm(packIndexTarget, { force: true })
    await rm(packRevTarget, { force: true })
    return { ok: false, reason }
  }
  try {
    // The enumeration capture itself is capped at the remaining bound, so a
    // closure that cannot fit is refused before its bytes ever land.
    let enumerated: Awaited<ReturnType<CommandRunner>>
    try {
      enumerated = await input.runCommand(list, environment, { stdoutFile: closureFile, stdoutCapBytes: Math.min(closureCapBytes, input.limitBytes) })
    } catch (error) {
      return await refuse(`snapshot object enumeration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (enumerated.code !== 0) return await refuse(`snapshot object enumeration failed: ${enumerated.stderr.trim()}`)
    const closureBytes = (await stat(closureFile)).size
    if (closureBytes === 0) return await refuse("snapshot object enumeration produced no objects")
    const packAllowance = input.limitBytes - closureBytes
    if (packAllowance <= 0) return await refuse(`closure list ${formatBytesOf(closureBytes)} already exceeds the remaining ${formatBytesOf(input.limitBytes)} bound`)
    await mkdir(packDirectory, { recursive: true })
    try {
      const pack = await input.runCommand(["git", `--git-dir=${input.gitDir}`, "pack-objects", "--quiet", "--stdout"], environment, { stdinFile: closureFile, stdoutFile: packTarget, stdoutCapBytes: packAllowance })
      if (pack.code !== 0) return await refuse(`snapshot object materialization failed: ${pack.stderr.trim()}`)
    } catch (error) {
      return await refuse(error instanceof Error ? error.message : "snapshot pack capture failed")
    }
    const indexed = await input.runCommand(["git", `--git-dir=${input.gitDir}`, "index-pack", packTarget], environment)
    if (indexed.code !== 0) return await refuse(`snapshot pack indexing failed: ${indexed.stderr.trim()}`)
    // index-pack derives the index name by replacing .pack (not appending),
    // and may also emit a .rev reverse-index file; all three count. The still
    // on-disk closure list counts toward the same acceptance bound.
    const bytes = (await stat(packTarget)).size + (await stat(packIndexTarget)).size + ((await pathExists(packRevTarget)) ? (await stat(packRevTarget)).size : 0)
    if (closureBytes + bytes > input.limitBytes) return await refuse(`closure list plus materialized pack set ${formatBytesOf(closureBytes + bytes)} exceeds the remaining ${formatBytesOf(input.limitBytes)} bound`)
    await rm(alternates, { force: true })
    const verified = await input.runCommand(list, environment, { stdoutFile: closureFile, stdoutCapBytes: Math.min(closureCapBytes, input.limitBytes) })
    if (verified.code !== 0) return await refuse(`snapshot object closure does not resolve after materialization: ${verified.stderr.trim()}`)
    return { ok: true, bytes }
  } finally {
    await rm(closureFile, { force: true })
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory)) {
    const info = await lstat(join(directory, entry)).catch(() => undefined)
    if (info?.isFile()) total += info.size
  }
  return total
}

function formatBytesOf(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} bytes` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
