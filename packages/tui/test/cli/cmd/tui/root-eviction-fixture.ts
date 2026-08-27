import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { json } from "./sync-fixture"

type Emit = (event: GlobalEvent) => void

export function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

export function row(id: string, parentID?: string) {
  return {
    id,
    parentID,
    title: id,
    slug: id,
    projectID: "proj_test",
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
  }
}

export function message(sessionID: string, index: number) {
  return {
    id: `msg_${sessionID}_${index}`,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: `msg_${sessionID}_user_${index}`,
    path: { cwd: "/tmp/opencode/packages/opencode", root: "/tmp/opencode/packages/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index, completed: index + 1 },
  }
}

export function fetchFor(rows: Map<string, ReturnType<typeof row>>, calls: Map<string, number>) {
  return (url: URL): Response | undefined => {
    const session = url.pathname.match(/^\/session\/([^/]+)$/)
    const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    const todo = url.pathname.match(/^\/session\/([^/]+)\/todo$/)
    const diff = url.pathname.match(/^\/session\/([^/]+)\/diff$/)
    const sessionID = session?.[1] ?? messages?.[1] ?? todo?.[1] ?? diff?.[1]
    if (sessionID === undefined) return undefined
    calls.set(sessionID, (calls.get(sessionID) ?? 0) + 1)
    if (session) return json(rows.get(sessionID) ?? row(sessionID))
    if (messages) return json([{ info: message(sessionID, 0), parts: [] }])
    return json([])
  }
}

export function userMessage(sessionID: string, index: number) {
  return {
    id: `msg_${sessionID}_user_${index}`,
    sessionID,
    role: "user" as const,
    agent: "build",
    model: { providerID: "test", modelID: "model" },
    mode: "build",
    path: { cwd: "/tmp/opencode/packages/opencode", root: "/tmp/opencode/packages/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index },
  }
}

export function emitRow(emit: Emit, value: ReturnType<typeof row>) {
  emit(global({ id: `evt_row_${value.id}`, type: "session.updated", properties: { sessionID: value.id, info: value } }))
}

export function emitCreated(emit: Emit, value: ReturnType<typeof row>) {
  emit(
    global({
      id: `evt_created_${value.id}`,
      type: "session.created",
      properties: { sessionID: value.id, info: value },
    }),
  )
}

export function emitDeleted(emit: Emit, value: ReturnType<typeof row>) {
  emit(
    global({
      id: `evt_deleted_${value.id}`,
      type: "session.deleted",
      properties: { sessionID: value.id, info: value },
    }),
  )
}

export function emitMessage(emit: Emit, value: ReturnType<typeof message> | ReturnType<typeof userMessage>) {
  emit(
    global({ id: `evt_${value.id}`, type: "message.updated", properties: { sessionID: value.sessionID, info: value } }),
  )
}

export function emitPart(emit: Emit, sessionID: string) {
  const part = {
    id: `prt_${sessionID}_1`,
    sessionID,
    messageID: `msg_${sessionID}_9`,
    type: "text" as const,
    text: "hello",
    time: { created: 9, start: 9, end: 9 },
  }
  emit(global({ id: `evt_part_${sessionID}`, type: "message.part.updated", properties: { sessionID, part, time: 9 } }))
}

export async function withSessionLimit(limit: string, run: () => Promise<void>) {
  const previousBudget = process.env.OPENCODE_TUI_PAYLOAD_BUDGET_MB
  const previousSessions = process.env.OPENCODE_TUI_PAYLOAD_SESSION_LIMIT
  process.env.OPENCODE_TUI_PAYLOAD_BUDGET_MB = "0"
  process.env.OPENCODE_TUI_PAYLOAD_SESSION_LIMIT = limit
  try {
    await run()
  } finally {
    if (previousBudget === undefined) delete process.env.OPENCODE_TUI_PAYLOAD_BUDGET_MB
    else process.env.OPENCODE_TUI_PAYLOAD_BUDGET_MB = previousBudget
    if (previousSessions === undefined) delete process.env.OPENCODE_TUI_PAYLOAD_SESSION_LIMIT
    else process.env.OPENCODE_TUI_PAYLOAD_SESSION_LIMIT = previousSessions
  }
}
