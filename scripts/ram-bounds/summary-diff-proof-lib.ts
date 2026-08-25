import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Database, constants } from "bun:sqlite"
import { copyBounded, createUnderCanonicalAncestor, materializeSnapshotObjects, pathExists } from "./summary-diff-proof-copy"

export type SqliteBindings = import("bun:sqlite").SQLQueryBindings

export type Diff = { readonly file: string; readonly additions: number; readonly deletions: number; readonly status: string | undefined; readonly hasPatch: boolean }

type SnapshotRefs = { readonly from: string; readonly to: string }

export type Message = { readonly id: string; readonly sessionID: string; readonly directory: string; readonly projectID: string; readonly worktree: string; readonly role: string; readonly parentID: string | undefined; readonly diffs: readonly Diff[]; readonly snapshots: SnapshotRefs | undefined }

export type Candidate = Message & { readonly expected: Diff }
export type RetainedCandidate = Candidate & { readonly snapshots: SnapshotRefs }

export type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string }

export type CommandOptions = {
  readonly stdinFile?: string
  readonly stdoutFile?: string
  readonly stdoutCapBytes?: number
}

export type CommandRunner = (command: readonly string[], environment: Record<string, string>, options?: CommandOptions) => Promise<CommandResult>

type MessageRow = { readonly id: string; readonly session_id: string; readonly data: string; readonly directory: string; readonly project_id: string; readonly worktree: string }

type PartRow = { readonly message_id: string; readonly data: string }

const worktreeLimitBytes = 300 * 1024 * 1024

export function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
}

export async function createSandbox(sourceInput: string): Promise<{ readonly root: string; readonly sourceRoot: string; readonly owned: boolean }> {
  const sourceRoot = await realpath(await validateConfiguredPath(sourceInput, "SOURCE_XDG_DATA_HOME", true))
  const configured = process.env.SANDBOX_XDG_DATA_HOME
  const sandboxLexical = configured ? await validateConfiguredPath(configured, "SANDBOX_XDG_DATA_HOME", false) : await mkdtemp(join(tmpdir(), "opencode-summary-diff-proof-"))
  const owned = configured === undefined
  try {
    const root = owned ? await realpath(sandboxLexical) : await createUnderCanonicalAncestor(sandboxLexical)
    if (sourceRoot === root || isWithin(sourceRoot, root) || isWithin(root, sourceRoot)) {
      if (owned) await rm(root, { recursive: true, force: true })
      throw new Error("SANDBOX_XDG_DATA_HOME must be separate from SOURCE_XDG_DATA_HOME after canonicalization")
    }
    if ((await readdir(root)).length > 0) throw new Error(`sandbox directory is not empty: ${root}`)
    await mkdir(join(root, "home"), { recursive: true })
    await mkdir(join(root, "config"), { recursive: true })
    await mkdir(join(root, "state"), { recursive: true })
    await mkdir(join(root, "cache"), { recursive: true })
    return { root, sourceRoot, owned }
  } catch (error) {
    if (owned) await rm(sandboxLexical, { recursive: true, force: true })
    throw error
  }
}

async function validateConfiguredPath(input: string, label: string, required: boolean): Promise<string> {
  if (input.split(/[\\/]+/).some((part) => part === "..")) throw new Error(`${label} must not contain path-traversal components`)
  const absolute = resolve(input)
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`${label} must not itself be a symlink: ${absolute}`)
    return absolute
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && !required) return absolute
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`${label} does not exist: ${absolute}`)
    throw error
  }
}

export function selectMetadataCandidate(messages: readonly Message[]): Candidate | undefined {
  return messageCandidates(messages).find((candidate) => !candidate.expected.hasPatch)
}

export async function loadCandidates(databaseFilename: string): Promise<readonly Message[]> {
  const database = new Database(databaseFilename, constants.SQLITE_OPEN_READONLY)
  try {
    const messages = database.query<MessageRow, SqliteBindings[]>("SELECT m.id, m.session_id, m.data, s.directory, s.project_id, p.worktree FROM message m JOIN session s ON s.id = m.session_id JOIN project p ON p.id = s.project_id ORDER BY m.time_created ASC, m.id ASC").all()
    const parts = database.query<PartRow, SqliteBindings[]>("SELECT message_id, data FROM part ORDER BY time_created ASC, id ASC").all()
    const partsByMessage = new Map<string, unknown[]>()
    for (const row of parts) {
      const value: unknown = JSON.parse(row.data)
      const list = partsByMessage.get(row.message_id) ?? []
      list.push(value)
      partsByMessage.set(row.message_id, list)
    }
    return messages.flatMap((row) => {
      const value: unknown = JSON.parse(row.data)
      if (!isRecord(value)) return []
      return [{ id: row.id, sessionID: row.session_id, directory: row.directory, projectID: row.project_id, worktree: row.worktree, role: typeof value.role === "string" ? value.role : "", parentID: typeof value.parentID === "string" ? value.parentID : undefined, diffs: readDiffs(value), snapshots: readSnapshots(partsByMessage.get(row.id) ?? []) } satisfies Message]
    })
  } finally {
    database.close()
  }
}

export async function prepareRetainedCandidate(input: {
  readonly messages: readonly Message[]
  readonly sourceRoot: string
  readonly sandboxRoot: string
  readonly scratchDirectory: string
  readonly runCommand: CommandRunner
}): Promise<{ readonly candidate: RetainedCandidate | undefined; readonly detail: string }> {
  const candidates = messageCandidates(input.messages).filter(
    (candidate): candidate is RetainedCandidate => candidate.snapshots !== undefined,
  )
  const retained = (
    await Promise.all(
      candidates.map(async (candidate) => {
        const snapshot = snapshotDirectory(input.sourceRoot, candidate)
        if (!(await isDirectory(snapshot)) || !(await isCopyableWorktree(candidate.worktree))) return undefined
        return { candidate, snapshot }
      }),
    )
  ).filter((item): item is { readonly candidate: RetainedCandidate; readonly snapshot: string } => item !== undefined)
  if (!retained.length) {
    const reason = candidates.length
      ? `${candidates.length} snapshot candidates, none have retained storage and a copyable standalone worktree`
      : "no message has both step-start and step-finish snapshot hashes"
    return { candidate: undefined, detail: reason }
  }

  const measured = (
    await Promise.all(
      retained.map(async (item) => {
        const result = await input.runCommand(["du", "-s", "-B1", "--", item.candidate.worktree], {
          PATH: process.env.PATH ?? "",
        })
        if (result.code !== 0) throw new Error(`could not measure retained worktree: ${commandFailure(result)}`)
        const bytes = Number(result.stdout.trim().split(/\s+/, 1)[0])
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("du returned an invalid retained worktree size")
        return { ...item, bytes }
      }),
    )
  ).toSorted((left, right) => left.bytes - right.bytes)
  if (!measured.length) return { candidate: undefined, detail: "retained candidates could not be measured" }
  if (measured[0].bytes > worktreeLimitBytes) {
    return {
      candidate: undefined,
      detail: `${measured.length} retained candidates, smallest worktree ${formatBytes(measured[0].bytes)} > 300 MiB bound`,
    }
  }

  // Try every qualifying candidate smallest-first; a candidate whose copy or
  // materialization fails must not mask a later candidate that would satisfy
  // the proof.
  const failures: string[] = []
  for (const attempt of measured) {
    // Every attempt starts from a clean scratch so a failed attempt's partial
    // worktree cannot leak into the next candidate's copy.
    await rm(input.scratchDirectory, { recursive: true, force: true })
    if (attempt.bytes > worktreeLimitBytes) {
      failures.push(`${attempt.candidate.id}: worktree ${formatBytes(attempt.bytes)} exceeds the bound`)
      continue
    }
    try {
      await copyBounded(attempt.candidate.worktree, input.scratchDirectory, worktreeLimitBytes)
    } catch {
      await rm(input.scratchDirectory, { recursive: true, force: true })
      failures.push(`${attempt.candidate.id}: worktree exceeded the bound during bounded copy`)
      continue
    }
    const scratch = await realpath(input.scratchDirectory)
    const destination = join(
      input.sandboxRoot,
      "opencode",
      "snapshot",
      attempt.candidate.projectID,
      sha1(scratch),
    )
    await mkdir(dirname(destination), { recursive: true })
    try {
      const copied = await copyBounded(attempt.snapshot, destination, worktreeLimitBytes)
      const materialized = await materializeSnapshotObjects({
        gitDir: destination,
        hashes: [attempt.candidate.snapshots.from, attempt.candidate.snapshots.to],
        limitBytes: worktreeLimitBytes - copied,
        runCommand: input.runCommand,
      })
      if (!materialized.ok) throw new Error(materialized.reason)
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      failures.push(`${attempt.candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    return {
      candidate: attempt.candidate,
      detail: `selected ${attempt.candidate.id}; copied ${formatBytes(attempt.bytes)} worktree and materialized self-contained snapshot storage`,
    }
  }
  return { candidate: undefined, detail: `${measured.length} retained candidates tried: ${failures.join("; ")}` }
}

function messageCandidates(messages: readonly Message[]): readonly Candidate[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !message.diffs.length) return []
    const expected = message.diffs.find((diff) => !diff.hasPatch) ?? message.diffs[0]
    if (!expected) return []
    const related = messages.filter(
      (item) => item.id === message.id || (item.role === "assistant" && item.parentID === message.id),
    )
    return [{ ...message, snapshots: combineSnapshots(related), expected }]
  })
}

function combineSnapshots(messages: readonly Message[]): SnapshotRefs | undefined {
  let from: string | undefined
  let to: string | undefined
  for (const message of messages) {
    if (!from && message.snapshots?.from) from = message.snapshots.from
    if (message.snapshots?.to) to = message.snapshots.to
  }
  return from && to ? { from, to } : undefined
}

function readSnapshots(parts: readonly unknown[]): SnapshotRefs | undefined {
  let from: string | undefined
  let to: string | undefined
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === "step-start" && typeof part.snapshot === "string" && !from) from = part.snapshot
    if (part.type === "step-finish" && typeof part.snapshot === "string") to = part.snapshot
  }
  return from && to ? { from, to } : undefined
}

function readDiffs(value: Readonly<Record<string, unknown>>): readonly Diff[] {
  const diffs = isRecord(value.summary) && Array.isArray(value.summary.diffs) ? value.summary.diffs : []
  return diffs.flatMap((diff) => {
    if (!isRecord(diff) || typeof diff.file !== "string" || typeof diff.additions !== "number" || !Number.isFinite(diff.additions) || typeof diff.deletions !== "number" || !Number.isFinite(diff.deletions)) return []
    return [{ file: diff.file, additions: diff.additions, deletions: diff.deletions, status: typeof diff.status === "string" ? diff.status : undefined, hasPatch: typeof diff.patch === "string" } satisfies Diff]
  })
}

function snapshotDirectory(sourceRoot: string, candidate: RetainedCandidate): string {
  return join(sourceRoot, "opencode", "snapshot", candidate.projectID, sha1(candidate.worktree))
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex")
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function commandFailure(result: CommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim()
  return `exit ${result.code}${output ? `: ${output}` : ""}`
}

async function isDirectory(filename: string): Promise<boolean> {
  try {
    return (await lstat(filename)).isDirectory()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

async function isCopyableWorktree(filename: string): Promise<boolean> {
  if (!(await isDirectory(filename))) return false
  try {
    const gitdir = join(filename, ".git")
    if (!(await lstat(gitdir)).isDirectory()) return false
    // Alternates would chain the sandbox copy to a live object store.
    return !(await pathExists(join(gitdir, "objects", "info", "alternates")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
