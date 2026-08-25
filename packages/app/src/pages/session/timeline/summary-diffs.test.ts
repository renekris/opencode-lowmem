import { describe, expect, mock, test } from "bun:test"
import type { SnapshotFileDiff, UserMessage } from "@opencode-ai/sdk/v2"
import { uniqueSummaryDiffs } from "./summary-diffs"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline } = await import("./rows")

const diff = (file: string, additions: number) =>
  ({
    file,
    additions,
    deletions: 0,
  }) satisfies SnapshotFileDiff

describe("uniqueSummaryDiffs", () => {
  test("drops entries without files and preserves unique input", () => {
    const alpha = diff("alpha.ts", 1)
    const beta = diff("beta.ts", 1)
    const invalid = { additions: 1, deletions: 0 } satisfies SnapshotFileDiff

    expect(uniqueSummaryDiffs(undefined)).toEqual([])
    expect(uniqueSummaryDiffs([])).toEqual([])
    expect(uniqueSummaryDiffs([invalid])).toEqual([])

    const result = uniqueSummaryDiffs([alpha, invalid, beta])
    expect(result).toEqual([alpha, beta])
    expect(result[0]).toBe(alpha)
    expect(result[1]).toBe(beta)
  })

  test("keeps the last diff per file in the legacy display order", () => {
    const oldAlpha = diff("alpha.ts", 1)
    const oldBeta = diff("beta.ts", 1)
    const newAlpha = diff("alpha.ts", 2)
    const charlie = diff("charlie.ts", 1)
    const newBeta = diff("beta.ts", 2)

    const result = uniqueSummaryDiffs([oldAlpha, oldBeta, newAlpha, charlie, newBeta])

    expect(result).toEqual([newAlpha, charlie, newBeta])
    expect(result[0]).toBe(newAlpha)
    expect(result[1]).toBe(charlie)
    expect(result[2]).toBe(newBeta)
  })

  test("creates a visible row from deduplicated metadata-only diffs", () => {
    const oldAlpha = diff("alpha.ts", 1)
    const newAlpha = diff("alpha.ts", 2)
    const beta = diff("beta.ts", 1)
    const userMessage = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      summary: { diffs: [oldAlpha, newAlpha, beta] },
    } as unknown as UserMessage

    const rows = Timeline.constructMessageRows(userMessage, () => [], [], 0, false, "idle", false, false)

    expect(rows).toContainEqual(
      expect.objectContaining({
        _tag: "DiffSummary",
        userMessageID: "msg_1",
        diffs: [newAlpha, beta],
      }),
    )
  })
})
