import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import {
  SUBAGENT_COMPLETED_LIMIT,
  bootstrapSubagentData,
  createSubagentData,
  listSubagentTabs,
  reduceSubagentData,
} from "@/cli/cmd/run/subagent-data"

type SubagentData = ReturnType<typeof createSubagentData>

function completedTaskPart(sessionID: string, end: number) {
  return {
    id: `part-${sessionID}`,
    sessionID: "parent-1",
    messageID: `msg-${sessionID}`,
    type: "tool" as const,
    callID: `call-${sessionID}`,
    tool: "task",
    state: {
      status: "completed" as const,
      input: {
        description: "Scan reducer paths",
        subagent_type: "explore",
      },
      output: "",
      title: "Reducer touchpoints",
      metadata: {
        sessionId: sessionID,
        toolcalls: 4,
      },
      time: { start: end - 1, end },
    },
  }
}

function runningTaskPart(sessionID: string, start: number) {
  return {
    id: `part-${sessionID}`,
    sessionID: "parent-1",
    messageID: `msg-${sessionID}`,
    type: "tool" as const,
    callID: `call-${sessionID}`,
    tool: "task",
    state: {
      status: "running" as const,
      input: {
        description: "Scan reducer paths",
        subagent_type: "explore",
      },
      title: "Reducer touchpoints",
      metadata: {
        sessionId: sessionID,
        toolcalls: 4,
      },
      time: { start },
    },
  }
}

function taskUpdated(part: ReturnType<typeof completedTaskPart> | ReturnType<typeof runningTaskPart>) {
  return {
    type: "message.part.updated",
    properties: { part },
  }
}

function reduce(data: SubagentData, event: unknown, pinnedSessionID?: string) {
  return reduceSubagentData({
    data,
    event: event as Event,
    sessionID: "parent-1",
    thinking: true,
    limits: {},
    ...(pinnedSessionID ? { pinnedSessionID } : {}),
  })
}

function seedCompleted(data: SubagentData, count: number, options?: { skip?: Set<string> }) {
  for (let index = 0; index < count; index++) {
    const sessionID = `child-${String(index).padStart(2, "0")}`
    if (options?.skip?.has(sessionID)) {
      continue
    }

    reduce(data, taskUpdated(completedTaskPart(sessionID, 1000 + index)))
  }
}

describe("subagent lifecycle conveyor", () => {
  test("orders running tabs first, then completed oldest-to-newest", () => {
    const data = createSubagentData()

    seedCompleted(data, 3)
    reduce(data, taskUpdated(runningTaskPart("child-run", 1)))

    const tabs = listSubagentTabs(data)
    expect(tabs.map((tab) => tab.sessionID)).toEqual(["child-run", "child-00", "child-01", "child-02"])
    expect(tabs.map((tab) => tab.status)).toEqual(["running", "completed", "completed", "completed"])
  })

  test("evicts the oldest completed tab and detail beyond the limit", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT + 1)

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(false)
    expect(data.details.has("child-00")).toBe(false)
    expect(data.tabs.has(`child-${String(SUBAGENT_COMPLETED_LIMIT).padStart(2, "0")}`)).toBe(true)
  })

  test("keeps the inspected session pinned during eviction", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT, { skip: new Set(["child-00"]) })
    reduce(data, taskUpdated(completedTaskPart("child-00", 999)), "child-00")
    seedCompleted(data, 1, { skip: new Set(["child-00"]) })
    reduce(
      data,
      taskUpdated(completedTaskPart(`child-${String(SUBAGENT_COMPLETED_LIMIT).padStart(2, "0")}`, 2000)),
      "child-00",
    )

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(true)
    expect(data.tabs.has("child-01")).toBe(false)
  })

  test("keeps sessions with queued permissions during eviction", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT)
    reduce(data, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "child-00",
        permission: "bash",
        patterns: ["git status --short"],
        metadata: {},
        always: [],
        tool: {
          messageID: "msg-child-00",
          callID: "call-child-00",
        },
      },
    })
    reduce(data, taskUpdated(completedTaskPart("child-new", 9000)))

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(true)
    expect(data.tabs.has("child-01")).toBe(false)
    expect(data.tabs.has("child-new")).toBe(true)
  })

  test("never evicts running tabs even when they are the oldest", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(runningTaskPart("child-run", 1)))
    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT)
    reduce(data, taskUpdated(completedTaskPart("child-new", 9000)))

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT + 1)
    expect(data.tabs.get("child-run")?.status).toBe("running")
    expect(data.tabs.has("child-00")).toBe(false)
  })

  test("re-creates a tab when an evicted session is resumed", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT + 1)
    expect(data.tabs.has("child-00")).toBe(false)

    reduce(data, taskUpdated(runningTaskPart("child-00", 9500)))

    expect(data.tabs.get("child-00")?.status).toBe("running")
  })

  test("caps completed tabs during bootstrap hydration", () => {
    const data = createSubagentData()
    const count = SUBAGENT_COMPLETED_LIMIT + 5

    bootstrapSubagentData({
      data,
      messages: Array.from({ length: count }, (_, index) => ({
        parts: [completedTaskPart(`child-${String(index).padStart(2, "0")}`, 1000 + index)],
      })),
      children: [],
      permissions: [],
      questions: [],
    })

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(false)
    expect(data.tabs.has("child-04")).toBe(false)
    expect(data.tabs.has("child-05")).toBe(true)
    expect(data.tabs.has(`child-${String(count - 1).padStart(2, "0")}`)).toBe(true)
  })
})
