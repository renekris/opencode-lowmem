import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionSummary.node,
      Snapshot.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
    ]),
  ),
)

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const big = Array.from({ length: 3000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n")

describe("session summary memory retention", () => {
  it.instance(
    "stores metadata-only summary diffs and recomputes full patches while snapshots survive",
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
        expect(diff.patch).toBeUndefined()
      }

      const onDemand = yield* summary.diff({ sessionID: sid, messageID: user.id })
      expect(onDemand.length).toBeGreaterThan(0)
      expect(onDemand.some((diff) => typeof diff.patch === "string" && diff.patch.includes("+line 0"))).toBe(true)

      const events = yield* EventV2Bridge.Service
      const replayed = yield* events
        .durable({ aggregateID: sid, after: 0 })
        .pipe(Stream.take(6), Stream.runCollect)
      const replayedEvent = Array.from(replayed)
        .filter((event) => event.type === "message.updated")
        .at(-1)
      if (!replayedEvent || replayedEvent.type !== "message.updated") {
        throw new Error("expected replayed message.updated.1 event")
      }
      expect(replayedEvent.durable?.version).toBe(1)
      const replayedData = Schema.decodeUnknownSync(SessionV1.Event.MessageUpdated.data)(replayedEvent.data)
      if (replayedData.info.role !== "user" || !replayedData.info.summary) {
        throw new Error("expected replayed user summary")
      }
      expect(replayedData.info.summary.diffs?.every((diff) => diff.patch === undefined)).toBe(true)

      const trimmedPayload = JSON.stringify(
        Schema.encodeUnknownSync(SessionV1.Event.MessageUpdated.data)(replayedData),
      )
      const fullPayload = JSON.stringify(
        Schema.encodeUnknownSync(SessionV1.Event.MessageUpdated.data)({
          ...replayedData,
          info: {
            ...replayedData.info,
            summary: { ...replayedData.info.summary, diffs: onDemand },
          },
        }),
      )
      if (trimmedPayload === undefined || fullPayload === undefined) throw new Error("expected serializable payloads")
      const trimmedBytes = Buffer.byteLength(trimmedPayload, "utf8")
      const fullBytes = Buffer.byteLength(fullPayload, "utf8")
      expect(fullBytes / trimmedBytes).toBeGreaterThanOrEqual(100)
    }),
    { git: true },
  )

  it.instance(
    "fork strips full patches from legacy summaries before re-publishing",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const session = yield* Session.Service

      const sid = (yield* session.create({})).id as SessionID
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        sessionID: sid,
        agent: "default",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        time: { created: Date.now() },
        summary: {
          diffs: [
            {
              file: "legacy.txt",
              additions: 3000,
              deletions: 0,
              status: "added",
              patch: Array.from({ length: 3000 }, (_, index) => `+line ${index}`).join("\n"),
            },
          ],
        },
      })

      const forked = yield* session.fork({ sessionID: sid })

      const events = yield* EventV2Bridge.Service
      const replayed = yield* events
        .durable({ aggregateID: forked.id, after: 0 })
        .pipe(
          Stream.filter((event) => event.type === "message.updated"),
          Stream.take(1),
          Stream.runCollect,
        )
      const updated = Array.from(replayed)
      expect(updated.length).toBeGreaterThan(0)
      for (const event of updated) {
        if (event.type !== "message.updated") continue
        const data = Schema.decodeUnknownSync(SessionV1.Event.MessageUpdated.data)(event.data)
        if (data.info.role !== "user") continue
        for (const diff of data.info.summary?.diffs ?? []) {
          expect(diff.patch).toBeUndefined()
          expect(diff.file).toBe("legacy.txt")
          expect(diff.additions).toBe(3000)
        }
      }
    }),
    { git: true },
  )
})
