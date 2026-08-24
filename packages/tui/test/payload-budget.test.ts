import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import vectors from "./env-limit-vectors.json" with { type: "json" }
import {
  createPayloadBudget,
  parseEnvLimit,
  serializedUtf8Bytes,
} from "../src/context/payload-budget"
import { createPartDeltaBuffer } from "../src/context/part-delta-buffer"

describe("payload budget", () => {
  test("uses UTF-8 serialized bytes and the shared parser vectors", () => {
    expect(serializedUtf8Bytes("é")).toBe(4)
    for (const vector of vectors.bytes) expect(parseEnvLimit(vector.input, "1MB")).toBe(vector.expected)
    for (const vector of vectors.counts) expect(parseEnvLimit(vector.input, "1", "count")).toBe(vector.expected)
    for (const input of vectors.invalidBytes) expect(() => parseEnvLimit(input, "1MB")).toThrow()
    for (const input of vectors.invalidCounts) expect(() => parseEnvLimit(input, "1", "count")).toThrow()
  })

  test("accounts message, part, todo, and diff replacements across protection classes", () => {
    const budget = createPayloadBudget({
      budgetBytes: 100,
      sessionLimit: 10,
      isProtected: (sessionID) => sessionID === "active",
    })
    const message = { id: "msg_1", role: "assistant", text: "é" }
    const part = { id: "prt_1", sessionID: "active", messageID: "msg_1", type: "text", text: "part" }

    budget.replaceMessage("active", message.id, message)
    budget.replacePart(message.id, part.id, part.sessionID, part)
    budget.replaceTodo("active", [{ content: "todo" }])
    budget.replaceDiff("active", [{ file: "a.ts", patch: "é" }])

    expect(budget.stats()).toMatchObject({
      evictableResident: 0,
      protectedResident:
        serializedUtf8Bytes(message) + serializedUtf8Bytes(part) +
        serializedUtf8Bytes([{ content: "todo" }]) + serializedUtf8Bytes([{ file: "a.ts", patch: "é" }]),
      protectedSessionCount: 1,
    })

    budget.replaceMessage("active", message.id, { ...message, text: "changed" })
    expect(budget.stats().protectedResident).toBe(
      serializedUtf8Bytes({ ...message, text: "changed" }) +
        serializedUtf8Bytes(part) +
        serializedUtf8Bytes([{ content: "todo" }]) +
        serializedUtf8Bytes([{ file: "a.ts", patch: "é" }]),
    )
  })

  test("truncates only declared scalar leaves and retains permission inputs", () => {
    const budget = createPayloadBudget({ partIngressBytes: 4 })
    const text = {
      id: "prt_text",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "ééé",
    } satisfies Part
    const tool = {
      id: "prt_tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "keep" },
        output: "ééé",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } satisfies Part
    const textResult = budget.preparePart("ses_1", text)
    const toolResult = budget.preparePart("ses_1", tool)

    expect(textResult.type).toBe("text")
    if (textResult.type !== "text") return
    expect(textResult.text).toContain("payload omitted")
    expect(toolResult.type).toBe("tool")
    if (toolResult.type !== "tool" || toolResult.state.status !== "completed") return
    expect(toolResult.state.output).toContain("payload omitted")
    expect(toolResult.state.input).toEqual({ filePath: "keep" })
    expect(budget.isTruncated("msg_1", "prt_text")).toBe(true)

    budget.setPermissionInput("ses_1", "per_1", "msg_1", "call_1", { filePath: "é" })
    expect(budget.permissionInput("msg_1", "call_1")).toEqual({ filePath: "é" })
    budget.clearPermissionRequest("ses_1", "per_1")
    expect(budget.permissionInput("msg_1", "call_1")).toBeUndefined()
  })

  test("zero disables byte and count eviction limits", () => {
    const budget = createPayloadBudget({ budgetBytes: 0, sessionLimit: 0 })
    budget.replaceMessage("ses_1", "msg_1", { text: "x".repeat(1000) })
    budget.replaceMessage("ses_2", "msg_2", { text: "x".repeat(1000) })
    expect(budget.overLimit()).toBe(false)
    expect(budget.stats().evictableSessionCount).toBe(2)
  })

  test("clears part and pending bytes atomically when a message bucket is removed", () => {
    const budget = createPayloadBudget()
    const part = { id: "prt_atomic", sessionID: "ses_atomic", messageID: "msg_atomic", type: "text", text: "pending" } satisfies Part

    budget.replacePart(part.messageID, part.id, part.sessionID, part)
    budget.replacePendingDelta(part.messageID, 64)
    expect(budget.stats().evictableResident).toBe(serializedUtf8Bytes(part) + 64)

    budget.removeParts(part.messageID)
    expect(budget.stats().evictableResident).toBe(0)
    expect(budget.messageIDs(part.sessionID)).toEqual([])
  })

  test("retains every outstanding permission input without applying payload caps", () => {
    const budget = createPayloadBudget({ permissionAllowanceBytes: 1 })

    for (let index = 0; index < 257; index++)
      budget.setPermissionInput("ses_permission", `per_${index}`, "msg_permission", `call_${index}`, {
        filePath: `/${"x".repeat(256)}/${index}`,
      })

    expect(budget.stats().permissionBytes).toBeGreaterThan(257)
    for (let index = 0; index < 257; index++) budget.clearPermissionRequest("ses_permission", `per_${index}`)
    expect(budget.stats().permissionBytes).toBe(0)
  })

  test("flushes delta entries at byte or count pressure and decrements dropped bytes", () => {
    const applied: string[] = []
    const buffer = createPartDeltaBuffer({
      maxBytes: 4,
      maxEntries: 1,
      intervalMs: 10_000,
      apply: (entry) => applied.push(entry.accumulated),
    })
    buffer.push({ messageID: "msg_1", partID: "prt_1", field: "text", delta: "éé" })
    expect(buffer.pendingBytes()).toBe(4)
    buffer.push({ messageID: "msg_2", partID: "prt_2", field: "text", delta: "x" })
    expect(applied).toEqual(["éé"])
    expect(buffer.pendingBytes()).toBe(1)
    buffer.dropMessage("msg_2")
    expect(buffer.pendingBytes()).toBe(0)
    expect(buffer.pendingCount()).toBe(0)
  })

})
