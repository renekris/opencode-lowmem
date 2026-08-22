import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Session.node, SessionProjector.node, SessionSummary.node, Snapshot.node, CrossSpawnSpawner.node]),
  ),
)

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const big = Array.from({ length: 3000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n")

describe("session summary memory retention", () => {
  it.instance(
    "stores capped summary patches that survive snapshot pruning",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory
      const session = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const snapshot = yield* Snapshot.Service

      yield* Effect.promise(() => fs.writeFile(path.join(dir, "big.txt"), "seed\n"))
      const info = yield* session.create({})
      const sid = info.id as SessionID

      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        sessionID: sid,
        agent: "default",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
      })

      const assistant = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant" as const,
        sessionID: sid,
        mode: "default",
        agent: "default",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        parentID: user.id,
        time: { created: Date.now() },
        finish: "end_turn",
      })

      const before = yield* snapshot.track()
      if (!before) throw new Error("expected before snapshot")
      yield* Effect.promise(() => fs.writeFile(path.join(dir, "big.txt"), `${big}\n`))
      const after = yield* snapshot.track()
      if (!after) throw new Error("expected after snapshot")

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: sid,
        type: "step-start" as const,
        snapshot: before,
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: sid,
        type: "step-finish" as const,
        reason: "stop",
        snapshot: after,
        cost: 0,
        tokens,
      })

      yield* summary.summarize({ sessionID: sid, messageID: user.id })

      const messages = yield* session.messages({ sessionID: sid })
      const target = messages.find((item) => item.info.id === user.id)
      if (!target || target.info.role !== "user") throw new Error("expected user message")

      const stored = target.info.summary?.diffs ?? []
      expect(stored.length).toBeGreaterThan(0)
      for (const diff of stored) {
        expect(typeof diff.patch).toBe("string")
      }

      const onDemand = yield* summary.diff({ sessionID: sid, messageID: user.id })
      expect(onDemand.length).toBeGreaterThan(0)
      expect(onDemand.some((diff) => typeof diff.patch === "string" && diff.patch.includes("+line 0"))).toBe(true)
    }),
    { git: true },
  )
})
