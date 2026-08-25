import { open } from "node:fs/promises"
import type { CommandOptions, CommandResult } from "./summary-diff-proof-lib"

const commandTimeoutMs = 10 * 60 * 1000
const captureTextCapBytes = 1024 * 1024

export async function runCommand(command: readonly string[], environment: Record<string, string>, options: CommandOptions = {}): Promise<CommandResult> {
  const stdinFile = options.stdinFile !== undefined ? await open(options.stdinFile, "r") : undefined
  const child = Bun.spawn([...command], {
    env: environment,
    stdin: options.input !== undefined ? "pipe" : stdinFile !== undefined ? stdinFile.fd : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const stdin = child.stdin
    if (options.input !== undefined && stdin && typeof stdin !== "number") {
      stdin.write(options.input)
      await stdin.end()
    }
    const collect = options.stdoutFile !== undefined ? captureToFile(child, options.stdoutFile, options.stdoutCapBytes) : captureToText(child.stdout, captureTextCapBytes)
    return await Promise.race([
      Promise.all([child.exited, collect, captureToText(child.stderr, captureTextCapBytes)]).then(([code, stdout, stderr]) => ({ code, stdout, stderr })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`command timed out after ${commandTimeoutMs}ms: ${command[0] ?? "unknown"}`)), commandTimeoutMs)
      }),
    ])
  } catch (error) {
    await stopProcess(child, command[0] ?? "command")
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    await stdinFile?.close()
  }
}

// Streams stdout straight to a file so no unbounded buffer is held in this
// process; the optional cap aborts (and the caller kills the child) instead of
// letting a pathological enumeration consume the disk.
async function captureToFile(child: Bun.Subprocess, filename: string, capBytes: number | undefined): Promise<string> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("command stdout is not piped")
  const target = await open(filename, "w")
  const reader = child.stdout.getReader()
  let written = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      written += value.byteLength
      if (capBytes !== undefined && written > capBytes) throw new Error(`command stdout exceeded ${capBytes} byte capture cap`)
      await target.write(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    await target.close()
  }
  return ""
}

// Bounded in-memory capture: a pathological command cannot grow this process
// past the cap (replacing this with Response(stream).text() would reintroduce
// an unbounded buffer); exceeding it aborts the await and the caller kills
// the child.
async function captureToText(stream: ReadableStream<Uint8Array> | number, capBytes: number): Promise<string> {
  if (typeof stream === "number") throw new Error("command stream is not piped")
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let loaded = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.byteLength
      if (loaded > capBytes) throw new Error(`command output exceeded ${capBytes} byte capture cap`)
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function stopProcess(child: Bun.Subprocess, name: string): Promise<void> {
  child.kill("SIGTERM")
  if (await exitedWithin(child, shutdownGraceTimeoutMs)) return
  child.kill("SIGKILL")
  if (await exitedWithin(child, shutdownHardTimeoutMs)) return
  throw new Error(`${name} did not exit within bounded shutdown deadline`)
}

const shutdownGraceTimeoutMs = 2_000
const shutdownHardTimeoutMs = 2_000

async function exitedWithin(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([child.exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
