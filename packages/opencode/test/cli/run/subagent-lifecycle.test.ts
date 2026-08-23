import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import {
  SUBAGENT_COMPLETED_LIMIT,
  bootstrapSubagentData,
  createSubagentData,
  listSubagentPermissions,
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

function backgroundTaskPart(sessionID: string, end: number, status: "completed" | "error" = "completed") {
  const part = completedTaskPart(sessionID, end)
  return {
    ...part,
    state: {
      ...part.state,
      metadata: { ...part.state.metadata, background: true },
      ...(status === "error" ? { status: "error" as const, error: "boom" } : {}),
    },
  }
}

function settleTextPart(sessionID: string, state: "completed" | "error" = "completed", synthetic = true) {
  return {
    id: `settle-${sessionID}`,
    sessionID: "parent-1",
    messageID: `settle-${sessionID}`,
    type: "text" as const,
    synthetic,
    text: `<task id="${sessionID}" state="${state}">\n<summary>Background task ${state}: demo</summary>\n<task_result>\n</task_result>\n</task>`,
  }
}

function permissionAsked(sessionID: string) {
  return {
    type: "permission.asked",
    properties: {
      id: `perm-${sessionID}`,
      sessionID,
      permission: "bash",
      patterns: ["git status --short"],
      metadata: {},
      always: [],
      tool: {
        messageID: `msg-${sessionID}`,
        callID: `call-${sessionID}`,
      },
    },
  }
}

function permissionReplied(sessionID: string) {
  return {
    type: "permission.replied",
    properties: {
      sessionID,
      requestID: `perm-${sessionID}`,
    },
  }
}

function taskUpdated(part: unknown) {
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

function terminalMessage(sessionID: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: `msg-${sessionID}`,
        sessionID,
        role: "assistant",
        time: { created: 999, completed: 1200 },
      },
    },
  }
}

describe("subagent background settlement", () => {
  test("keeps a completed background part running until the injection settles it", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(backgroundTaskPart("child-bg", 1000)))

    expect(data.tabs.get("child-bg")?.status).toBe("running")
    expect(data.tabs.get("child-bg")?.background).toBe(true)

    reduce(data, taskUpdated(settleTextPart("child-bg")))

    expect(data.tabs.get("child-bg")?.status).toBe("completed")
  })

  test("background error parts settle immediately and stay evictable", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(backgroundTaskPart("child-bg-err", 1000, "error")))

    expect(data.tabs.get("child-bg-err")?.status).toBe("error")
  })

  test("unsettled background tabs are never evicted, settled ones join the cap", () => {
    const data = createSubagentData()
    const count = SUBAGENT_COMPLETED_LIMIT + 1

    for (let index = 0; index < count; index++) {
      reduce(data, taskUpdated(backgroundTaskPart(`child-${String(index).padStart(2, "0")}`, 1000 + index)))
    }
    expect(data.tabs.size).toBe(count)

    for (let index = 0; index < count; index++) {
      const sessionID = `child-${String(index).padStart(2, "0")}`
      reduce(data, taskUpdated(settleTextPart(sessionID)))
    }

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(false)
    expect(data.tabs.has(`child-${String(count - 1).padStart(2, "0")}`)).toBe(true)
  })

  test("settle injections for unknown sessions are ignored", () => {
    const data = createSubagentData()

    expect(reduce(data, taskUpdated(settleTextPart("child-ghost")))).toBe(false)
    expect(data.tabs.size).toBe(0)
  })

  test("non-synthetic parent text cannot spoof a settlement", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(backgroundTaskPart("child-bg", 1000)))
    reduce(data, taskUpdated(settleTextPart("child-bg", "completed", false)))
    expect(data.tabs.get("child-bg")?.status).toBe("running")

    reduce(data, taskUpdated(settleTextPart("child-bg")))
    expect(data.tabs.get("child-bg")?.status).toBe("completed")
  })

  test("bootstrap replays settle text parts over background task parts", () => {
    const data = createSubagentData()

    bootstrapSubagentData({
      data,
      messages: [
        { parts: [backgroundTaskPart("child-bg", 1000) as ReturnType<typeof completedTaskPart>] },
        { parts: [settleTextPart("child-bg") as unknown as ReturnType<typeof completedTaskPart>] },
      ],
      children: [],
      permissions: [],
      questions: [],
    })

    expect(data.tabs.get("child-bg")?.status).toBe("completed")
  })

  test("child terminal message does not settle a background tab (extend keeps the job running)", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(backgroundTaskPart("child-bg", 1000)))
    reduce(data, terminalMessage("child-bg"))

    expect(data.tabs.get("child-bg")?.status).toBe("running")
  })

  test("child terminal message does not retire a revived tab; the injection settles it", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT + 1)
    reduce(data, permissionAsked("child-00"))
    expect(data.tabs.get("child-00")?.status).toBe("running")

    reduce(data, terminalMessage("child-00"))
    expect(data.tabs.get("child-00")?.status).toBe("running")

    reduce(data, taskUpdated(settleTextPart("child-00", "error")))
    expect(data.tabs.get("child-00")?.status).toBe("error")
  })

  test("child terminal assistant message does not settle a foreground tab", () => {
    const data = createSubagentData()

    reduce(data, taskUpdated(runningTaskPart("child-fg", 1000)))
    reduce(data, terminalMessage("child-fg"))

    expect(data.tabs.get("child-fg")?.status).toBe("running")
  })
})

describe("subagent eviction revival", () => {
  test("revives a tab when an evicted session asks for permission", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT + 1)
    expect(data.tabs.has("child-00")).toBe(false)
    expect(data.evicted.has("child-00")).toBe(true)

    reduce(data, permissionAsked("child-00"))

    const tab = data.tabs.get("child-00")
    expect(tab?.status).toBe("running")
    expect(tab?.label).toBe("Explore")
    expect(data.evicted.has("child-00")).toBe(false)
    expect(listSubagentPermissions(data).some((item) => item.id === "perm-child-00")).toBe(true)
  })

  test("revived tabs settle when the background injection lands", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT + 1)
    reduce(data, permissionAsked("child-00"))
    reduce(data, taskUpdated(settleTextPart("child-00", "error")))

    expect(data.tabs.get("child-00")?.status).toBe("error")
  })

  test("guarded tabs squat the cap; new completions bounce but stay revivable", () => {
    const data = createSubagentData()

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT)
    for (let index = 0; index < SUBAGENT_COMPLETED_LIMIT; index++) {
      reduce(data, permissionAsked(`child-${String(index).padStart(2, "0")}`))
    }
    reduce(data, taskUpdated(completedTaskPart("child-a", 9000)))

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-a")).toBe(false)
    expect(data.evicted.has("child-a")).toBe(true)

    reduce(data, taskUpdated(runningTaskPart("child-a", 9500)))

    expect(data.tabs.get("child-a")?.status).toBe("running")
    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT + 1)
  })

  test("equal timestamps order and evict deterministically by session id", () => {
    const ordered = createSubagentData()
    for (const sessionID of ["child-z", "child-a", "child-m", "child-b"]) {
      reduce(ordered, taskUpdated(completedTaskPart(sessionID, 5000)))
    }

    expect(listSubagentTabs(ordered).map((tab) => tab.sessionID)).toEqual(["child-a", "child-b", "child-m", "child-z"])
    expect(ordered.evicted.size).toBe(0)

    const data = createSubagentData()
    for (let index = 0; index <= SUBAGENT_COMPLETED_LIMIT; index++) {
      reduce(data, taskUpdated(completedTaskPart(`child-${String(index).padStart(2, "0")}`, 5000)))
    }

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.evicted.has("child-00")).toBe(true)
    expect(data.tabs.has("child-00")).toBe(false)
    const listed = listSubagentTabs(data).map((tab) => tab.sessionID)
    expect(listed[0]).toBe("child-01")
    expect(listed[listed.length - 1]).toBe("child-50")
  })

  test("guard overflow heals back to the cap once replies release the guards", () => {
    const data = createSubagentData()
    const overflowID = `child-${String(SUBAGENT_COMPLETED_LIMIT).padStart(2, "0")}`

    seedCompleted(data, SUBAGENT_COMPLETED_LIMIT)
    for (let index = 0; index < SUBAGENT_COMPLETED_LIMIT; index++) {
      reduce(data, permissionAsked(`child-${String(index).padStart(2, "0")}`))
    }
    reduce(data, taskUpdated(completedTaskPart(overflowID, 9000)), overflowID)
    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT + 1)

    reduce(data, permissionReplied("child-00"))

    expect(data.tabs.size).toBe(SUBAGENT_COMPLETED_LIMIT)
    expect(data.tabs.has("child-00")).toBe(false)
    expect(data.tabs.has(overflowID)).toBe(true)
    expect(listSubagentPermissions(data).some((item) => item.id === "perm-child-00")).toBe(false)
  })
})
