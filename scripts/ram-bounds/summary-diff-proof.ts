import { Database } from "bun:sqlite"
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { runCommand, stopProcess } from "./summary-diff-proof-proc"
import {
  createSandbox,
  isWithin,
  loadCandidates,
  prepareRetainedCandidate,
  selectMetadataCandidate,
  type Candidate,
  type CommandResult,
  type Diff,
} from "./summary-diff-proof-lib"

type Check = { readonly status: "PASS" | "FAIL" | "SKIP"; readonly name: string; readonly detail: string }
type Server = { readonly process: Bun.Subprocess; readonly port: number }

const defaultBinary = "packages/opencode/dist/opencode-linux-x64/bin/opencode"
const databaseName = "opencode.db"
const serverReadyTimeoutMs = 30_000
const requestTimeoutMs = 10_000

async function main(): Promise<void> {
  if (!(await runProof())) process.exitCode = 1
}

async function runProof(): Promise<boolean> {
  const binary = resolve(process.cwd(), process.env.BIN ?? defaultBinary)
  const sourceInput = process.env.SOURCE_XDG_DATA_HOME
  if (!sourceInput) throw new Error("SOURCE_XDG_DATA_HOME is required and must point to the source data root")
  const sqlite3 = Bun.which("sqlite3")
  if (!sqlite3) throw new Error("sqlite3 is required for a WAL-safe sandbox copy; install the sqlite3 CLI and retry")
  const sandbox = await createSandbox(sourceInput)
  const checks: Check[] = []
  try {
    const sourceDatabase = await findSourceDatabase(sandbox.sourceRoot)
    const sandboxDatabase = join(sandbox.root, "opencode", databaseName)
    await backupDatabase(sqlite3, sourceDatabase, sandboxDatabase, sandbox.root)
    const scratchDirectory = join(sandbox.root, "project")
    await mkdir(scratchDirectory, { recursive: true })
    const messages = await loadCandidates(sandboxDatabase)
    const retained = await prepareRetainedCandidate({
      messages,
      sourceRoot: sandbox.sourceRoot,
      sandboxRoot: sandbox.root,
      scratchDirectory,
      runCommand,
    })
    await remapSessionDirectories(sandboxDatabase, sandbox.root, scratchDirectory)
    if (!(await pathExists(binary))) throw new Error(`binary not found at ${binary}; build first with the allowed fork build command`)
    const environment = isolatedEnvironment(sandbox.root)
    const list = await runCommand([binary, "session", "list", "--format", "json"], environment)
    if (list.code !== 0) {
      checks.push({ status: "FAIL", name: "session list", detail: commandFailure(list) })
      printSummary(checks)
      return false
    }
    const listed: unknown = JSON.parse(list.stdout.trim() || "[]")
    if (!Array.isArray(listed)) {
      checks.push({ status: "FAIL", name: "session list", detail: "did not return a JSON array" })
      printSummary(checks)
      return false
    }
    checks.push({ status: "PASS", name: "session list", detail: listed.length === 0 ? "exit 0; empty-ok" : `exit 0; ${listed.length} session(s)` })

    const metadata = selectMetadataCandidate(messages)
    const metadataRequest = metadata ? { ...metadata, directory: scratchDirectory } : undefined
    const retainedRequest = retained.candidate ? { ...retained.candidate, directory: scratchDirectory } : undefined
    if (!metadataRequest && !retainedRequest) {
      checks.push({ status: "SKIP", name: "metadata-only diff request", detail: "sandbox database has no message summary with a metadata-only diff" })
      checks.push({ status: "SKIP", name: "retained-snapshot diff request", detail: retained.detail })
      printSummary(checks)
      return true
    }

    const server = await startServer(binary, environment)
    try {
      if (metadataRequest) await checkMetadata(server, metadataRequest, checks)
      else checks.push({ status: "SKIP", name: "metadata-only diff request", detail: "no metadata-only summary candidate" })
      if (retainedRequest) await checkRetained(server, retainedRequest, checks)
      else checks.push({ status: "SKIP", name: "retained-snapshot diff request", detail: retained.detail })
    } finally {
      await stopServer(server)
    }
    printSummary(checks)
    return checks.every((check) => check.status !== "FAIL")
  } finally {
    if (sandbox.owned) await rm(sandbox.root, { recursive: true, force: true })
  }
}

async function findSourceDatabase(sourceRoot: string): Promise<string> {
  const dataDirectory = join(sourceRoot, "opencode")
  const entries = await readdir(dataDirectory, { withFileTypes: true })
  const databases = entries
    .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => (left === databaseName ? -1 : right === databaseName ? 1 : left.localeCompare(right)))
  const database = databases[0]
  if (!database) throw new Error(`no opencode database found under ${dataDirectory}`)
  return join(dataDirectory, database)
}

async function backupDatabase(sqlite3: string, sourceFilename: string, destinationFilename: string, sandboxRoot: string): Promise<void> {
  if (!isWithin(sandboxRoot, resolve(destinationFilename))) throw new Error("sandbox database destination must stay inside the sandbox")
  if (/['\p{Cc}]/u.test(destinationFilename)) throw new Error("sandbox database destination cannot contain quotes or control characters")
  await mkdir(dirname(destinationFilename), { recursive: true })
  const result = await runCommand([sqlite3, "--readonly", sourceFilename, `.backup '${destinationFilename}'`], { PATH: process.env.PATH ?? "" })
  if (result.code !== 0) throw new Error(`sqlite3 backup failed: ${commandFailure(result)}`)
}

function isolatedEnvironment(sandboxRoot: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(sandboxRoot, "home"),
    XDG_DATA_HOME: sandboxRoot,
    XDG_CONFIG_HOME: join(sandboxRoot, "config"),
    XDG_STATE_HOME: join(sandboxRoot, "state"),
    XDG_CACHE_HOME: join(sandboxRoot, "cache"),
    LANG: process.env.LANG ?? "C",
    TZ: process.env.TZ ?? "UTC",
  }
}

async function remapSessionDirectories(databaseFilename: string, sandboxRoot: string, scratchDirectory: string): Promise<void> {
  const databasePath = await realpath(databaseFilename)
  const scratchPath = await realpath(scratchDirectory)
  if (!isWithin(sandboxRoot, databasePath) || !isWithin(sandboxRoot, scratchPath)) throw new Error("sandbox remap paths must stay inside the sandbox")
  const writable = new Database(databaseFilename)
  try {
    writable.run("UPDATE session SET directory = ?", [scratchPath])
  } finally {
    writable.close()
  }
}

async function startServer(binary: string, environment: Record<string, string>): Promise<Server> {
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], { env: environment, stdout: "pipe", stderr: "pipe" })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const port = await Promise.race([waitForPort(child), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("server readiness timed out")), serverReadyTimeoutMs) })])
    return { process: child, port }
  } catch (error) {
    await stopProcess(child, "server")
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopServer(server: Server): Promise<void> {
  await stopProcess(server.process, "server")
}

async function waitForPort(child: Bun.Subprocess): Promise<number> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("server stdout is not piped")
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`server exited before readiness: ${output.trim()}`)
    output += decoder.decode(chunk.value, { stream: true })
    const match = output.match(/opencode server listening on http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/)
    if (match?.[1]) return Number(match[1])
  }
}

async function requestDiff(server: Server, candidate: Candidate): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const response = await fetch(`http://127.0.0.1:${server.port}/session/${encodeURIComponent(candidate.sessionID)}/diff?messageID=${encodeURIComponent(candidate.id)}`, { headers: { "x-opencode-directory": candidate.directory }, signal: AbortSignal.timeout(requestTimeoutMs) })
  const body = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const value: unknown = JSON.parse(body)
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("response was not a JSON diff array")
  return value
}

async function checkMetadata(server: Server, candidate: Candidate, checks: Check[]): Promise<void> {
  try {
    const response = await requestDiff(server, candidate)
    if (!response.some((diff) => preservesMetadata(diff, candidate.expected))) throw new Error("response did not preserve stored file/count/status metadata")
    checks.push({ status: "PASS", name: "metadata-only diff request", detail: `HTTP 200; metadata preserved for ${candidate.id}` })
  } catch (error) {
    checks.push({ status: "FAIL", name: "metadata-only diff request", detail: describeError(error) })
  }
}

async function checkRetained(server: Server, candidate: Candidate, checks: Check[]): Promise<void> {
  try {
    const response = await requestDiff(server, candidate)
    const diff = response.find((item) => preservesMetadata(item, candidate.expected))
    if (!diff || typeof diff.patch !== "string" || !diff.patch || diff.patch.startsWith("[opencode: patch omitted")) throw new Error("response did not contain a real full patch string")
    checks.push({ status: "PASS", name: "retained-snapshot diff request", detail: `HTTP 200; full patch returned for ${candidate.id}` })
  } catch (error) {
    checks.push({ status: "FAIL", name: "retained-snapshot diff request", detail: describeError(error) })
  }
}

function preservesMetadata(diff: Readonly<Record<string, unknown>>, expected: Diff): boolean {
  return diff.file === expected.file && diff.additions === expected.additions && diff.deletions === expected.deletions && (expected.status === undefined || diff.status === expected.status)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function commandFailure(result: CommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim()
  return `exit ${result.code}${output ? `: ${output}` : ""}`
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function pathExists(filename: string): Promise<boolean> {
  try { await stat(filename); return true } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

function printSummary(checks: readonly Check[]): void {
  console.log("Summary-diff sandbox proof")
  for (const check of checks) console.log(`${check.status} ${check.name}: ${check.detail}`)
}

main().catch((error: unknown) => { console.error(`Summary-diff sandbox proof\nFAIL sandbox proof: ${describeError(error)}`); process.exitCode = 1 })
