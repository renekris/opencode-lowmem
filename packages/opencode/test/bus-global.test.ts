import { describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

describe("GlobalBus", () => {
  test("adds event identity and removes listeners", () => {
    const seen: GlobalEvent[] = []
    const listener = (event: GlobalEvent) => seen.push(event)
    const payload: { type: string; id?: string } = { type: "test" }

    GlobalBus.on("event", listener)
    try {
      expect(GlobalBus.emit("event", { payload })).toBe(true)
      expect(payload.id).toStartWith("evt_")
      expect(seen).toHaveLength(1)
      expect(seen[0]?.payload).toBe(payload)
    } finally {
      GlobalBus.off("event", listener)
    }

    GlobalBus.emit("event", { payload: { type: "after-removal" } })
    expect(seen).toHaveLength(1)
  })
})
