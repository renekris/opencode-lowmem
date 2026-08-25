// Fork-custom offline vacuum guard, kept separate from upstream-shaped database statistics.
// The live-handle scan and exclusive-lock procedure are fork-custom safeguards.

import { readdir, readlink, realpath } from "node:fs/promises"
import { formatBytes, readPragma } from "./db"

type LiveDatabaseHandle = {
  readonly pid: string
  readonly path: string
}

export async function vacuumDatabase(filename: string): Promise<void> {
  if (filename === ":memory:") throw new Error("Cannot vacuum :memory: database")
  if (!(await Bun.file(filename).exists())) throw new Error(`Cannot vacuum database: file does not exist: ${filename}`)
  if (process.platform !== "linux") {
    console.log("Warning: /proc liveness detection is Linux-only; only the exclusive lock guard applies.")
  }

  const { Database: SqliteDatabase } = await import("bun:sqlite")
  const database = new SqliteDatabase(filename)
  try {
    try {
      // locking_mode binds on the NEXT lock acquisition, so it must be set before
      // BEGIN: then the exclusive lock is persistent (held through COMMIT into
      // VACUUM until close) and no writer can interleave in the commit-to-vacuum
      // interval. Set after BEGIN it would only bind on a later acquisition.
      database.run("PRAGMA locking_mode = EXCLUSIVE")
      database.run("BEGIN EXCLUSIVE")
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : ""
      throw new Error(`Refusing to vacuum ${filename}: exclusive lock unavailable${reason}`)
    }

    const liveHandle = await findLiveDatabaseHandle(filename)
    if (liveHandle) {
      throw new Error(`Refusing to vacuum ${filename}: live process ${liveHandle.pid} has ${liveHandle.path} open`)
    }

    const pageSize = readPragma(database, "page_size")
    const freelistCount = readPragma(database, "freelist_count")
    const beforeBytes = Bun.file(filename).size
    const expectedReclaim = pageSize * freelistCount
    console.log(`Expected reclaim: ${formatBytes(expectedReclaim)} (${freelistCount} free pages x ${pageSize} bytes)`)
    if (freelistCount === 0) console.log("unlikely to reclaim material space")

    database.run("COMMIT")
    database.run("VACUUM")
    console.log(`Vacuum complete: file_bytes ${beforeBytes} -> ${Bun.file(filename).size}`)
  } finally {
    database.close()
  }
}

async function findLiveDatabaseHandle(filename: string): Promise<LiveDatabaseHandle | undefined> {
  if (process.platform !== "linux") return undefined

  // The scan is best-effort; the procedure remains protected by the exclusive lock.
  const databasePaths = await Promise.all(
    [filename, `${filename}-wal`, `${filename}-shm`].map((filePath) => realpath(filePath).catch(() => undefined)),
  )
  const databaseTargets = new Set(databasePaths.filter((filePath): filePath is string => filePath !== undefined))
  const processes = await readdir("/proc", { withFileTypes: true }).catch(() => [])
  for (const processEntry of processes) {
    // Ignore this CLI process: its guard connection is expected.
    if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name) || processEntry.name === String(process.pid)) {
      continue
    }
    const fds = await readdir(`/proc/${processEntry.name}/fd`).catch(() => [])
    const handles = await Promise.allSettled(
      fds.map(async (fd) => realpath(await readlink(`/proc/${processEntry.name}/fd/${fd}`))),
    )
    for (const handle of handles) {
      if (handle.status === "fulfilled" && databaseTargets.has(handle.value)) {
        return { pid: processEntry.name, path: handle.value }
      }
    }
  }
  return undefined
}
