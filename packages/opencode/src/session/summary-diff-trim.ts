import type { Snapshot } from "@/snapshot"

export function trimSummaryDiffs(diffs: readonly Snapshot.FileDiff[]): Snapshot.FileDiff[] {
  return diffs.map(({ patch: _, ...metadata }) => metadata)
}
