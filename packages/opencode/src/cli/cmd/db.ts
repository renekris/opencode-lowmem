import type { Argv } from "yargs"
import { spawn } from "child_process"
import { pathToFileURL } from "node:url"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { cmd } from "./cmd"
import { vacuumDatabase } from "./db-vacuum"

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

export function readPragma(database: SqliteDatabase, name: string) {
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

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
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
