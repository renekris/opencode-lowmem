import { expect, test } from "bun:test"
import type { PermissionRequest } from "../src/v2/gen/types.gen"

const requestWithToolInput: PermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: [],
  metadata: {},
  always: [],
  toolInput: { command: "echo hello" },
}

const requestWithoutToolInput: PermissionRequest = {
  id: "per_2",
  sessionID: "ses_1",
  permission: "bash",
  patterns: [],
  metadata: {},
  always: [],
}

test("generated PermissionRequest exposes optional toolInput", () => {
  expect(requestWithToolInput.toolInput).toEqual({ command: "echo hello" })
  expect(requestWithoutToolInput.toolInput).toBeUndefined()
})
