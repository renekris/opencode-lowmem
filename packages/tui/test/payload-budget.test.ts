import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import vectors from "../../core/test/env-limit-vectors.json" with { type: "json" }
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
    const textResult = budget.preparePart("ses_1", text).part
    const toolResult = budget.preparePart("ses_1", tool).part

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

  test("keeps a scalar at the byte cap by reference and preserves accounting bytes", () => {
    const part = {
      id: "prt_cap_boundary",
      sessionID: "ses_cap_boundary",
      messageID: "msg_cap_boundary",
      type: "text",
      text: "é",
    } satisfies Part
    const measuredBytes = serializedUtf8Bytes(part)
    const budget = createPayloadBudget({ partIngressBytes: serializedUtf8Bytes(part.text) })

    const prepared = budget.preparePart(part.sessionID, part)

    expect(prepared.part).toBe(part)
    expect(prepared.measuredBytes).toBe(measuredBytes)
    budget.replacePart(part.messageID, part.id, part.sessionID, prepared.part, prepared.measuredBytes)
    expect(budget.stats().evictableResident).toBe(measuredBytes)
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

  test("aggregates pending delta bytes for every part of one message", () => {
    const messageID = "msg_delta_sum"
    const partA = { id: "prt_delta_a", sessionID: "ses_delta_sum", messageID, type: "text", text: "" } satisfies Part
    const partB = { id: "prt_delta_b", sessionID: "ses_delta_sum", messageID, type: "text", text: "" } satisfies Part
    const budget = createPayloadBudget()
    budget.replacePart(messageID, partA.id, partA.sessionID, partA)
    budget.replacePart(messageID, partB.id, partB.sessionID, partB)
    let afterPartA: number | undefined
    const buffer = createPartDeltaBuffer({
      maxBytes: 0,
      maxEntries: 0,
      intervalMs: 10_000,
      onPendingBytes: budget.replacePendingDelta,
      apply: (entry) => {
        if (entry.partID === partA.id) afterPartA = budget.stats().evictableResident
      },
    })
    const delta = "x".repeat(3 * 1024 * 1024)
    const deltaBytes = 3 * 1024 * 1024
    const partBytes = serializedUtf8Bytes(partA) + serializedUtf8Bytes(partB)

    buffer.push({ messageID, partID: partA.id, field: "text", delta })
    buffer.push({ messageID, partID: partB.id, field: "text", delta })

    expect(budget.stats().evictableResident).toBe(partBytes + 2 * deltaBytes)
    expect(buffer.flushMessages([messageID])).toEqual([
      { messageID, partID: partA.id },
      { messageID, partID: partB.id },
    ])
    expect(afterPartA).toBe(partBytes + deltaBytes)
    expect(budget.stats().evictableResident).toBe(partBytes)
  })

  test("stores an oversized permission input as a dialog-visible marker", () => {
    const budget = createPayloadBudget({ permissionAllowanceBytes: 64 })
    const input = { filePath: "/" + "x".repeat(256) }

    budget.setPermissionInput("ses_permission", "per_oversized", "msg_permission", "call_oversized", input)

    const stored = budget.permissionInput("msg_permission", "call_oversized")
    expect(stored?.filePath).toContain("payload omitted by lowmem budget")
    expect(stored).not.toEqual(input)
  })

  test("truncates new permission inputs when the total map allowance is reached", () => {
    const budget = createPayloadBudget({ permissionAllowanceBytes: 1000 })
    const input = { filePath: "x".repeat(400) }

    for (let index = 0; index < 4; index++) {
      budget.setPermissionInput("ses_permission", `per_${index}`, "msg_permission", `call_${index}`, input)
    }
    budget.setPermissionInput("ses_permission", "per_total", "msg_permission", "call_total", input)

    expect(budget.permissionInput("msg_permission", "call_0")).toEqual(input)
    expect(budget.permissionInput("msg_permission", "call_3")).toEqual(input)
    expect(budget.permissionInput("msg_permission", "call_total")?.filePath).toContain("payload omitted by lowmem budget")
    expect(budget.stats().permissionBytes).toBeLessThanOrEqual(2000)
  })

  test("exact zero keeps permission inputs unbounded", () => {
    const budget = createPayloadBudget({ permissionAllowanceBytes: 0 })
    const input = { filePath: "/" + "x".repeat(256) }

    for (let index = 0; index < 257; index++) {
      budget.setPermissionInput("ses_permission", `per_${index}`, "msg_permission", `call_${index}`, input)
    }

    expect(budget.permissionInput("msg_permission", "call_0")).toEqual(input)
    expect(budget.stats().permissionBytes).toBe(257 * serializedUtf8Bytes(input))
    for (let index = 0; index < 257; index++) budget.clearPermissionRequest("ses_permission", `per_${index}`)
    expect(budget.stats().permissionBytes).toBe(0)
  })

  test("removing one tool part clears only its permission input", () => {
    const budget = createPayloadBudget()
    const partA = {
      id: "prt_permission_a",
      sessionID: "ses_permission_parts",
      messageID: "msg_permission_parts",
      type: "tool",
      callID: "call_a",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "a" },
        output: "done",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } satisfies Part
    const partB = { ...partA, id: "prt_permission_b", callID: "call_b" } satisfies Part
    budget.replacePart(partA.messageID, partA.id, partA.sessionID, partA)
    budget.replacePart(partB.messageID, partB.id, partB.sessionID, partB)
    budget.setPermissionInput(partA.sessionID, "per_a", partA.messageID, partA.callID, { filePath: "a" })
    budget.setPermissionInput(partB.sessionID, "per_b", partB.messageID, partB.callID, { filePath: "b" })

    budget.removePart(partA.messageID, partA.id)

    expect(budget.permissionInput(partA.messageID, partA.callID)).toBeUndefined()
    expect(budget.permissionInput(partB.messageID, partB.callID)).toEqual({ filePath: "b" })
  })

  test("a new permission survives cleanup of an old removed-part request", () => {
    const budget = createPayloadBudget()
    const part = {
      id: "prt_permission_reuse",
      sessionID: "ses_permission_reuse",
      messageID: "msg_permission_reuse",
      type: "tool",
      callID: "call_reuse",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "old" },
        output: "done",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } satisfies Part
    budget.replacePart(part.messageID, part.id, part.sessionID, part)
    budget.setPermissionInput(part.sessionID, "per_old", part.messageID, part.callID, { filePath: "old" })
    budget.removePart(part.messageID, part.id)
    budget.replacePart(part.messageID, part.id, part.sessionID, part)
    budget.setPermissionInput(part.sessionID, "per_new", part.messageID, part.callID, { filePath: "new" })

    budget.clearPermissionRequest(part.sessionID, "per_old")

    expect(budget.permissionInput(part.messageID, part.callID)).toEqual({ filePath: "new" })
  })

  test("caps oversized active parts while preserving smaller active parts", () => {
    const budget = createPayloadBudget({
      activePartMaxBytes: 32 * 1024 * 1024,
      isActive: (sessionID) => sessionID === "ses_active_cap",
      isProtected: (sessionID) => sessionID === "ses_active_cap",
    })
    const large = {
      id: "prt_active_large",
      sessionID: "ses_active_cap",
      messageID: "msg_active_cap",
      type: "text",
      text: "x".repeat(40 * 1024 * 1024),
    } satisfies Part
    const small = { ...large, id: "prt_active_small", text: "x".repeat(1024 * 1024) } satisfies Part
    const result = budget.preparePart(large.sessionID, large)

    expect(result.part.type).toBe("text")
    if (result.part.type !== "text") return
    expect(result.part.text).toContain("payload omitted by lowmem budget")
    expect(result.part).not.toBe(large)
    budget.replacePart(result.part.messageID, result.part.id, result.part.sessionID, result.part, result.measuredBytes)
    expect(budget.stats().protectedResident).toBe(serializedUtf8Bytes(result.part))
    expect(budget.preparePart(small.sessionID, small).part).toBe(small)
  })

  test("exact zero disables the active part cap", () => {
    const name = "OPENCODE_TUI_ACTIVE_PART_MAX_MB"
    const previous = process.env[name]
    process.env[name] = "0"
    try {
      const budget = createPayloadBudget({ isActive: () => true })
      const part = {
        id: "prt_active_unbounded",
        sessionID: "ses_active_unbounded",
        messageID: "msg_active_unbounded",
        type: "text",
        text: "x".repeat(40 * 1024 * 1024),
      } satisfies Part

      expect(budget.preparePart(part.sessionID, part).part).toBe(part)
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
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
