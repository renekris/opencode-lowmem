import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { copyFile, open } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cliIt } from "./lib/cli-process"

type SqliteDatabase = import("bun:sqlite").Database
type SqliteBindings = import("bun:sqlite").SQLQueryBindings

async function createFixtureDatabase(filename: string) {
  const { Database: SqliteDatabase } = await import("bun:sqlite")
  const db = new SqliteDatabase(filename)
  try {
    db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT, time_created INTEGER, time_updated INTEGER, sandboxes TEXT)")
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)")
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.run("CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER)")
    db.run("CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)")
    db.run(
      "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES ('project-test', '/tmp/opencode-test', 'Test project', 1, 2, '[]')",
    )
    db.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session-test', 'project-test', 'test-session', '/tmp/opencode-test', 'Test session', '1.18.22', 3, 4)",
    )
    db.run(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (\'message-test\', \'session-test\', 5, 6, \'{"role":"user","content":"fixture"}\')',
    )
    db.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part-test', 'message-test', 'session-test', 7, 8, '{\"type\":\"text\",\"text\":\"fixture\"}')",
    )
    db.run("INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session-test', 1)")
    db.run(
      "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event-test', 'session-test', 1, 'session.created', '{\"sessionID\":\"session-test\"}')",
    )
  } finally {
    db.close()
  }
}

async function createBloatedFixtureDatabase(filename: string) {
  await createFixtureDatabase(filename)

  const { Database: SqliteDatabase } = await import("bun:sqlite")
  const db = new SqliteDatabase(filename)
  try {
    db.run("CREATE TABLE vacuum_fixture (value TEXT)")
    const insert = db.query("INSERT INTO vacuum_fixture (value) VALUES (?)")
    for (const index of Array.from({ length: 128 }, (_, value) => value)) {
      insert.run(`${index}${"x".repeat(4096)}`)
    }
    db.run("DELETE FROM vacuum_fixture")
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
}

async function createSidecarFixtureDatabase(filename: string, sourceFilename: string) {
  await copyFile(sourceFilename, filename)
  const { Database: SqliteDatabase } = await import("bun:sqlite")
  const db = new SqliteDatabase(filename)
  db.run("PRAGMA journal_mode=WAL")
  db.run("CREATE TABLE stats_sidecar_keeper (value TEXT)")
  db.run("INSERT INTO stats_sidecar_keeper (value) VALUES ('sidecar')")
  db.run("DELETE FROM stats_sidecar_keeper")
  return db
}

async function readFixtureExpectations(filename: string) {
  const { Database: SqliteDatabase, constants } = await import("bun:sqlite")
  const db = new SqliteDatabase(
    `${pathToFileURL(filename).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
  try {
    return {
      pageSize: readNumber(db, "PRAGMA page_size", "page_size"),
      pageCount: readNumber(db, "PRAGMA page_count", "page_count"),
      freelistCount: readNumber(db, "PRAGMA freelist_count", "freelist_count"),
      fileBytes: Bun.file(filename).size,
      walBytes: Bun.file(`${filename}-wal`).size,
      tableNames: ["event", "event_sequence", "message", "part", "project", "session"],
      tables: ["event", "session", "message", "part"].map((name) => ({
        name,
        rowCount: readNumber(db, `SELECT COUNT(*) AS row_count FROM "${name}"`, "row_count"),
      })),
    }
  } finally {
    db.close()
  }
}

function readNumber(database: SqliteDatabase, query: string, key: string) {
  const row = database.query<Record<string, number>, SqliteBindings[]>(query).get()
  if (!row) throw new Error(`SQLite fixture query returned no row: ${query}`)
  const value = row[key]
  if (value === undefined) throw new Error(`SQLite fixture query omitted ${key}: ${query}`)
  return Number(value)
}

async function snapshotDatabaseFiles(filename: string) {
  return Promise.all(
    ["", "-wal", "-shm", "-journal"].map(async (suffix) => {
      const filePath = `${filename}${suffix}`
      const file = Bun.file(filePath)
      const exists = await file.exists()
      return {
        filePath,
        exists,
        hash: exists
          ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : "",
      }
    }),
  )
}

describe("opencode db stats", () => {
  cliIt.live("reports read-only database statistics as a table", ({ home, opencode }) =>
    Effect.gen(function* () {
      const sourceFilename = path.join(home, "stats-source.sqlite")
      const filename = path.join(home, "stats-sidecar.sqlite")
      yield* Effect.promise(() => createFixtureDatabase(sourceFilename))
      const keeper = yield* Effect.promise(() => createSidecarFixtureDatabase(filename, sourceFilename))
      try {
        const expected = yield* Effect.promise(() => readFixtureExpectations(filename))
        const before = yield* Effect.promise(() => snapshotDatabaseFiles(filename))
        expect(before.slice(1).some((file) => file.exists)).toBe(true)

        const result = yield* opencode.spawn(["db", "stats"], {
          env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
        })

        opencode.expectExit(result, 0, "db stats")
        expect(result.stdout).toContain("Database statistics")
        expect(result.stdout).toContain("page_count")
        expect(result.stdout).toContain("freelist_count")
        for (const name of expected.tableNames) expect(result.stdout).toContain(`\n${name}\n`)
        expect(result.stdout).not.toMatch(/^(?:event|event_sequence|message|part|project|session)\t/m)

        const after = yield* Effect.promise(() => snapshotDatabaseFiles(filename))
        expect(after).toEqual(before)
      } finally {
        keeper.close()
      }
    }),
  )

  cliIt.live("reports machine-readable database statistics with --json", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "stats-json.sqlite")
      yield* Effect.promise(() => createFixtureDatabase(filename))
      const expected = yield* Effect.promise(() => readFixtureExpectations(filename))
      const before = yield* Effect.promise(() => snapshotDatabaseFiles(filename))
      expect(before.slice(1).every((file) => !file.exists)).toBe(true)

      const result = yield* opencode.spawn(["db", "stats", "--json"], {
        env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(result, 0, "db stats --json")
      const output: unknown = JSON.parse(result.stdout)
      expect(output).toEqual(
        expect.objectContaining({
          databasePath: filename,
          pageSize: expected.pageSize,
          pageCount: expected.pageCount,
          freelistCount: expected.freelistCount,
          databaseBytes: expected.pageSize * expected.pageCount,
          fileBytes: expected.fileBytes,
          walBytes: expected.walBytes,
          approximateBytesMethod:
            "not collected by default; use --exhaustive to scan table contents",
          tables: expected.tableNames.map((name) => ({ name })),
        }),
      )
      expect(JSON.stringify(output)).not.toMatch(/"rowCount"|"approximateBytes":/)

      const after = yield* Effect.promise(() => snapshotDatabaseFiles(filename))
      expect(after).toEqual(before)
      expect(after.slice(1).every((file) => !file.exists)).toBe(true)
    }),
  )

  cliIt.live("reports exhaustive machine-readable database statistics with --exhaustive", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "stats-exhaustive.sqlite")
      yield* Effect.promise(() => createFixtureDatabase(filename))
      const expected = yield* Effect.promise(() => readFixtureExpectations(filename))
      const before = yield* Effect.promise(() => snapshotDatabaseFiles(filename))

      const tableResult = yield* opencode.spawn(["db", "stats", "--exhaustive"], {
        env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(tableResult, 0, "db stats --exhaustive")
      expect(tableResult.stdout).toContain("Table\tRows\tApprox. payload bytes")
      for (const table of expected.tables) {
        expect(tableResult.stdout).toMatch(new RegExp(`^${table.name}\\t${table.rowCount}\\t\\S+ \\S+$`, "m"))
      }

      const result = yield* opencode.spawn(["db", "stats", "--json", "--exhaustive"], {
        env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(result, 0, "db stats --json --exhaustive")
      const output: unknown = JSON.parse(result.stdout)
      expect(output).toEqual(
        expect.objectContaining({
          databasePath: filename,
          pageSize: expected.pageSize,
          pageCount: expected.pageCount,
          freelistCount: expected.freelistCount,
          databaseBytes: expected.pageSize * expected.pageCount,
          fileBytes: expected.fileBytes,
          walBytes: expected.walBytes,
          approximateBytesMethod:
            "sum of CAST(column AS BLOB) UTF-8 cell lengths (logical payload estimate, not physical table/index size); reads a read-only immutable view of the main database file, excluding uncheckpointed WAL contents",
          tables: expect.arrayContaining(
            expected.tables.map((table) =>
              expect.objectContaining({
                name: table.name,
                rowCount: table.rowCount,
                approximateBytes: expect.any(Number),
              }),
            ),
          ),
        }),
      )

      const after = yield* Effect.promise(() => snapshotDatabaseFiles(filename))
      expect(after).toEqual(before)
    }),
  )

  cliIt.live("reports an empty in-memory database", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["db", "stats", "--json"], {
        env: { OPENCODE_DB: ":memory:", OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(result, 0, "db stats --json :memory:")
      const output: unknown = JSON.parse(result.stdout)
      expect(output).toEqual(
        expect.objectContaining({
          databasePath: ":memory:",
          pageSize: 4096,
          pageCount: 0,
          freelistCount: 0,
          databaseBytes: 0,
          fileBytes: 0,
          walBytes: 0,
          approximateBytesMethod:
            "not collected by default; use --exhaustive to scan table contents",
          tables: [],
        }),
      )
    }),
  )

  cliIt.live("fails without creating a missing database", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "missing.sqlite")
      expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(false)

      const result = yield* opencode.spawn(["db", "stats"], {
        env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(result, 1, "db stats missing database")
      expect(result.stderr).toContain(`Cannot read database: file does not exist: ${filename}`)
      expect(yield* Effect.promise(() => Bun.file(filename).exists())).toBe(false)
    }),
  )
})

describe("opencode db vacuum", () => {
  cliIt.live("refuses when the exclusive lock is unavailable", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "vacuum-locked.sqlite")
      yield* Effect.promise(() => createFixtureDatabase(filename))
      const { Database: SqliteDatabase } = yield* Effect.promise(() => import("bun:sqlite"))
      const blocker = new SqliteDatabase(filename)
      try {
        blocker.run("BEGIN EXCLUSIVE")
        const result = yield* opencode.spawn(["db", "vacuum"], {
          env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
        })

        opencode.expectExit(result, 1, "db vacuum locked database")
        expect(result.stderr).toContain("exclusive lock unavailable")
      } finally {
        blocker.run("ROLLBACK")
        blocker.close()
      }
    }),
  )

  if (process.platform === "linux") {
    cliIt.live("refuses when proc detects a live database handle", ({ home, opencode }) =>
      Effect.gen(function* () {
        const filename = path.join(home, "vacuum-live-handle.sqlite")
        yield* Effect.promise(() => createFixtureDatabase(filename))
        const rawHandle = yield* Effect.promise(() => open(filename, "r"))
        try {
          const result = yield* opencode.spawn(["db", "vacuum"], {
            env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
          })

          opencode.expectExit(result, 1, "db vacuum proc live handle")
          expect(result.stderr).toContain(`live process ${process.pid}`)
        } finally {
          yield* Effect.promise(() => rawHandle.close())
        }
      }),
    )
  }

  cliIt.live("reclaims free pages from a bloated database", ({ home, opencode }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "vacuum-bloated.sqlite")
      yield* Effect.promise(() => createBloatedFixtureDatabase(filename))
      const before = yield* Effect.promise(() => readFixtureExpectations(filename))
      expect(before.freelistCount).toBeGreaterThan(0)

      const result = yield* opencode.spawn(["db", "vacuum"], {
        env: { OPENCODE_DB: filename, OPENCODE_DISABLE_CHANNEL_DB: "1" },
      })

      opencode.expectExit(result, 0, "db vacuum bloated database")
      expect(result.stdout).toContain("Expected reclaim")
      expect(result.stdout).toContain("Vacuum complete")
      const after = yield* Effect.promise(() => readFixtureExpectations(filename))
      expect(after.freelistCount).toBe(0)
      expect(after.fileBytes).toBeLessThan(before.fileBytes)
    }),
  )

  cliIt.live("keeps the exclusive lock across the guard commit until vacuum", ({ home }) =>
    Effect.gen(function* () {
      const filename = path.join(home, "guard-sequence.sqlite")
      const { Database: SqliteDatabase } = yield* Effect.promise(() => import("bun:sqlite"))
      const setup = new SqliteDatabase(filename)
      try {
        setup.run("PRAGMA journal_mode = WAL")
        setup.run("CREATE TABLE guard (id INTEGER PRIMARY KEY, value TEXT)")
        setup.run("INSERT INTO guard (value) VALUES ('a')")
      } finally {
        setup.close()
      }
      // The commit-to-vacuum interval inside db.ts has no CLI seam to observe, so
      // this pins the SQLite property the production sequence depends on (WAL is
      // the production journal mode, and the ONLY mode where the orders differ):
      // locking_mode=EXCLUSIVE set BEFORE BEGIN binds to that acquisition and
      // persists past COMMIT, keeping competitors locked out through VACUUM. With
      // the pragma after BEGIN a WAL commit releases the lock and the competitor
      // acquires it — the interval the guard exists to close.
      const guard = new SqliteDatabase(filename)
      try {
        guard.run("PRAGMA locking_mode = EXCLUSIVE")
        guard.run("BEGIN EXCLUSIVE")
        guard.run("COMMIT")

        const competitor = new SqliteDatabase(filename)
        try {
          expect(() => competitor.run("BEGIN EXCLUSIVE")).toThrow("database is locked")
        } finally {
          competitor.close()
        }

        guard.run("VACUUM")
      } finally {
        guard.close()
      }
    }),
  )
})
