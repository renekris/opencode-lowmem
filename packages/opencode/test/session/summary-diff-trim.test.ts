import { describe, expect, test } from "bun:test"
import type { Snapshot } from "../../src/snapshot"
import { trimSummaryDiffs } from "../../src/session/summary-diff-trim"

describe("trimSummaryDiffs", () => {
  test("strips patch while preserving diff metadata", () => {
    const input = [
      {
        file: "src/index.ts",
        patch: "@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ] satisfies readonly Snapshot.FileDiff[]

    expect(trimSummaryDiffs(input)).toEqual([
      {
        file: "src/index.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ])
  })

  test("is idempotent for patchless entries", () => {
    const input = [
      {
        file: "src/é/файл.ts",
        additions: 4,
        deletions: 2,
        status: "modified",
      },
      { additions: 0, deletions: 0 },
    ] satisfies readonly Snapshot.FileDiff[]

    const trimmed = trimSummaryDiffs(input)

    expect(trimmed).toEqual(input)
    expect(trimSummaryDiffs(trimmed)).toEqual(input)
  })

  test("retains generated and vendor paths as metadata-only entries", () => {
    const input = [
      {
        file: "node_modules/generated/asset.js",
        patch: "large generated patch",
        additions: 120,
        deletions: 3,
        status: "modified",
      },
      {
        file: "dist/файл.js",
        patch: "large vendor patch",
        additions: 8,
        deletions: 0,
        status: "added",
      },
    ] satisfies readonly Snapshot.FileDiff[]

    expect(trimSummaryDiffs(input)).toEqual([
      {
        file: "node_modules/generated/asset.js",
        additions: 120,
        deletions: 3,
        status: "modified",
      },
      {
        file: "dist/файл.js",
        additions: 8,
        deletions: 0,
        status: "added",
      },
    ])
  })
})
