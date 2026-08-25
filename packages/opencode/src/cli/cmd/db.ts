import type { Argv } from "yargs"
import { spawn } from "child_process"
import { readdir, readlink, realpath } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"

type DatabaseTableStats = {
  readonly name: string
  readonly rowCount: number
  readonly approximateBytes: number
}

type DatabaseStats = {
  readonly databasePath: string
  readonly pageSize: number
  readonly pageCount: number
  readonly freelistCount: number
  readonly databaseBytes: number
  readonly fileBytes: number
  readonly walBytes: number
  readonly approximateBytesMethod: string
  readonly tables: readonly DatabaseTableStats[]
}

type LiveDatabaseHandle = {
  readonly pid: string
  readonly path: string
}

type SqliteDatabase = import("bun:sqlite").Database
type SqliteBindings = import("bun:sqlite").SQLQueryBindings

const StatsCommand = cmd<{}, { json?: boolean }>({
  command: "stats",
  describe: "show read-only database size statistics",
  builder: (yargs: Argv) =>
    yargs.option("json", {
      type: "boolean",
      default: false,
      describe: "Output machine-readable JSON",
    }),
  async handler(args) {
    const stats = await readDatabaseStats(Database.path())
    if (args.json) {
      console.log(JSON.stringify(stats, null, 2))
      return
    }
    printDatabaseStats(stats)
  },
})

const VacuumCommand = cmd<{}, {}>({
  command: "vacuum",
  describe: "reclaim free database pages while offline",
  async handler() {
    await vacuumDatabase(Database.path())
  },
})

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = cmd<{}, {}>({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(StatsCommand).command(VacuumCommand).command(PathCommand).command(QueryCommand).demandCommand()
  },
  handler() {},
})

async function readDatabaseStats(filename: string): Promise<DatabaseStats> {
  if (filename !== ":memory:" && !(await Bun.file(filename).exists())) {
    throw new Error(`Cannot read database: file does not exist: ${filename}`)
  }
  const { Database: SqliteDatabase, constants } = await import("bun:sqlite")
  const database =
    filename === ":memory:"
      ? new SqliteDatabase(filename)
      : new SqliteDatabase(
          // Bun 1.3.14 rejects file: URIs unless SQLITE_OPEN_URI is passed
          // (SQLITE_CANTOPEN otherwise); the flag is load-bearing, not optional.
          `${pathToFileURL(filename).href}?immutable=1`,
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
        )
  try {
    const pageSize = readPragma(database, "page_size")
    const pageCount = readPragma(database, "page_count")
    const freelistCount = readPragma(database, "freelist_count")
    const tableNames = database
      .query<
        { name: string },
        SqliteBindings[]
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    const tables = tableNames.map((table) => readTableStats(database, table.name))

    return {
      databasePath: filename,
      pageSize,
      pageCount,
      freelistCount,
      databaseBytes: pageSize * pageCount,
      fileBytes: filename === ":memory:" ? 0 : Bun.file(filename).size,
      walBytes: filename === ":memory:" ? 0 : Bun.file(`${filename}-wal`).size,
      approximateBytesMethod:
        "sum of CAST(column AS BLOB) UTF-8 cell lengths (logical payload estimate, not physical table/index size); reads a read-only immutable view of the main database file, excluding uncheckpointed WAL contents",
      tables,
    }
  } finally {
    database.close()
  }
}

function readPragma(database: SqliteDatabase, name: string) {
  const row = database.query<Record<string, number>, SqliteBindings[]>(`PRAGMA ${name}`).get()
  if (row) return Number(Object.values(row)[0])
  throw new Error(`SQLite PRAGMA ${name} returned no row`)
}

function readTableStats(database: SqliteDatabase, name: string): DatabaseTableStats {
  const identifier = quoteIdentifier(name)
  const columns = database.query<{ name: string }, SqliteBindings[]>(`PRAGMA table_info(${identifier})`).all()
  const approximateBytes = columns
    .map((column) => `COALESCE(length(CAST(${quoteIdentifier(column.name)} AS BLOB)), 0)`)
    .join(" + ")
  const expression = approximateBytes.length > 0 ? approximateBytes : "0"
  const row = database
    .query<
      { row_count: number; approximate_bytes: number },
      SqliteBindings[]
    >(`SELECT COUNT(*) AS row_count, COALESCE(SUM(${expression}), 0) AS approximate_bytes FROM ${identifier}`)
    .get()
  if (!row) throw new Error(`SQLite table ${name} returned no statistics row`)
  return {
    name,
    rowCount: Number(row.row_count),
    approximateBytes: Number(row.approximate_bytes),
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function printDatabaseStats(stats: DatabaseStats) {
  console.log("Database statistics")
  console.log(`Path\t${stats.databasePath}`)
  console.log(`page_size\t${stats.pageSize}`)
  console.log(`page_count\t${stats.pageCount}`)
  console.log(`freelist_count\t${stats.freelistCount}`)
  console.log(`database_bytes\t${formatBytes(stats.databaseBytes)}`)
  console.log(`file_bytes\t${formatBytes(stats.fileBytes)}`)
  console.log(`wal_bytes\t${formatBytes(stats.walBytes)}`)
  console.log(`approximate_bytes_method\t${stats.approximateBytesMethod}`)
  console.log()
  console.log("Table\tRows\tApprox. payload bytes")
  for (const table of stats.tables) {
    console.log(`${table.name}\t${table.rowCount}\t${formatBytes(table.approximateBytes)}`)
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

async function vacuumDatabase(filename: string): Promise<void> {
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
