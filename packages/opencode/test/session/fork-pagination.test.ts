import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, EventV2Bridge.node, Database.node])),
)

describe("Session.fork pagination", () => {
  it.instance("preserves same-timestamp parent and tail mappings across pages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const source = yield* session.create({})

      for (let index = 0; index < 49; index++) {
        yield* session.updateMessage({
          id: MessageID.ascending(),
          sessionID: source.id,
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } satisfies SessionV1.User)
      }
      const parent = yield* session.updateMessage({
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
        time: { created: 1 },
        parentID: parent.id,
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        mode: "test",
        agent: "test",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)
      const compaction = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "user",
        time: { created: 1 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: source.id,
        messageID: compaction.id,
        type: "compaction",
        auto: true,
        tail_start_id: assistant.id,
      } satisfies SessionV1.CompactionPart)

      const forked = yield* session.fork({ sessionID: source.id })
      const copied = yield* session.messages({ sessionID: forked.id })
      const copiedParent = copied.at(49)
      const copiedAssistant = copied.at(50)
      const copiedCompaction = copied.at(51)
      if (!copiedParent || !copiedAssistant || copiedAssistant.info.role !== "assistant" || !copiedCompaction) {
        throw new Error("expected forked boundary messages")
      }
      const tail = copiedCompaction.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      if (!tail) throw new Error("expected forked compaction part")

      expect(copied.map((message) => message.info.time.created)).toEqual(Array.from({ length: 52 }, () => 1))
      expect(copiedAssistant.info.parentID).toBe(copiedParent.info.id)
      expect(tail.tail_start_id).toBe(copiedAssistant.info.id)
    }),
  )

  it.instance("uses the entry horizon when source messages arrive during paging", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const source = yield* session.create({})

      for (let index = 0; index < 55; index++) {
        yield* session.updateMessage({
          id: MessageID.ascending(),
          sessionID: source.id,
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } satisfies SessionV1.User)
      }

      const seen: MessageID[] = []
      let appended: MessageID | undefined
      yield* MessageV2.forEachBefore({
        sessionID: source.id,
        each: (message) =>
          Effect.gen(function* () {
            seen.push(message.info.id)
            if (appended) return
            appended = (yield* session.updateMessage({
              id: MessageID.ascending(),
              sessionID: source.id,
              role: "user",
              time: { created: 1 },
              agent: "test",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            } satisfies SessionV1.User)).id
          }),
      })
      if (!appended) throw new Error("expected concurrent source append")

      expect(seen).toHaveLength(55)
      expect(seen).not.toContain(appended)
    }),
  )

  it.instance("clones all entry messages when the requested boundary is missing", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const source = yield* session.create({})

      for (let index = 0; index < 2; index++) {
        yield* session.updateMessage({
          id: MessageID.ascending(),
          sessionID: source.id,
          role: "user",
          time: { created: index },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } satisfies SessionV1.User)
      }

      const forked = yield* session.fork({ sessionID: source.id, messageID: MessageID.ascending() })

      expect(yield* session.messages({ sessionID: forked.id })).toHaveLength(2)
    }),
  )

  it.instance("keeps fork boundaries exclusive without hydrating the boundary payload", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const source = yield* session.create({})

      for (let index = 0; index < 55; index++) {
        yield* session.updateMessage({
          id: MessageID.ascending(),
          sessionID: source.id,
          role: "user",
          time: { created: index },
          agent: "test",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } satisfies SessionV1.User)
      }

      const boundary = yield* session.updateMessage({
        id: MessageID.ascending(),
        sessionID: source.id,
        role: "user",
        time: { created: 55 },
        agent: "test",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      } satisfies SessionV1.User)
      const part = yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: source.id,
        messageID: boundary.id,
        type: "text",
        text: "excluded",
      } satisfies SessionV1.TextPart)
      const database = yield* Database.Service

      yield* database.db.run(sql`UPDATE part SET data = ${"{"} WHERE id = ${part.id}`)

      const forked = yield* session.fork({ sessionID: source.id, messageID: boundary.id })
      const copied = yield* session.messages({ sessionID: forked.id })

      expect(copied).toHaveLength(55)
      expect(copied.at(-1)?.info.time.created).toBe(54)
    }),
  )
})
