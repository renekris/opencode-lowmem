import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
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
      Database.node,
    ]),
  ),
)

describe("SessionSummary targeted selection", () => {
  it.instance("keeps missing and nonuser targets empty", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const source = yield* session.create({})
      const user = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      const assistant = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "assistant",
        time: { created: 2 },
        parentID: user.id,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "test",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)
      const missing = MessageID.ascending()

      yield* summary.summarize({ sessionID: source.id, messageID: assistant.id })
      yield* summary.summarize({ sessionID: source.id, messageID: missing })

      expect(yield* summary.diff({ sessionID: source.id, messageID: assistant.id })).toEqual([])
      expect(yield* summary.diff({ sessionID: source.id, messageID: missing })).toEqual([])
    }),
  )

  it.instance("does not hydrate unrelated malformed parts for summary or diff", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const source = yield* session.create({})
      const unrelated = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      const unrelatedPart = yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: source.id,
        messageID: unrelated.id,
        type: "text",
        text: "unrelated",
      } satisfies SessionV1.TextPart)
      const target = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "user",
        time: { created: 2 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      const database = yield* Database.Service

      yield* database.db.run(sql`UPDATE part SET data = ${"{"} WHERE id = ${unrelatedPart.id}`)

      yield* summary.summarize({ sessionID: source.id, messageID: target.id })
      expect(yield* summary.diff({ sessionID: source.id, messageID: target.id })).toEqual([])
    }),
  )
})
