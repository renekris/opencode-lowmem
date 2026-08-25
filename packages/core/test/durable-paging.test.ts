import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV2 } from "@opencode-ai/core/session"
import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { testEffect } from "./lib/effect"

const readCount = { value: 0 }
const readHook: { current: (aggregateID: string) => Effect.Effect<void> } = { current: () => Effect.void }
const databaseLayer = LayerNode.compile(Database.node)
const eventLayer = EventV2.layerWith({
  beforeAggregateRead: (aggregateID) => readHook.current(aggregateID),
}).pipe(Layer.provide(databaseLayer))
const it = testEffect(Layer.merge(databaseLayer, eventLayer))

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const itSession = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const sessionLocation = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("EventV2 durable paging", () => {
  it.effect("pages an oversized first row without duplicate or zero-progress reads", () =>
    Effect.gen(function* () {
      readCount.value = 0
      readHook.current = () =>
        Effect.sync(() => {
          readCount.value++
        })
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      for (let index = 0; index < 1000; index++) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: aggregateID,
          messageID: SessionMessage.ID.make(`msg_${String(index).padStart(4, "0")}`),
          timestamp: DateTime.makeUnsafe(0),
          text: index === 0 ? "x".repeat(9 * 1024 * 1024) : String(index),
        })
      }

      const received = Array.from(yield* events.durable({ aggregateID }).pipe(Stream.take(1000), Stream.runCollect))

      expect(readCount.value).toBe(11)
      expect(received).toHaveLength(1000)
      expect(received.map((event) => event.durable?.seq)).toEqual(Array.from({ length: 1000 }, (_, index) => index))
      expect(new Set(received.map((event) => event.id)).size).toBe(1000)
    }),
  )

  it.effect("bounds decoded rows before applying the durable page byte limit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      const rowText = "x".repeat(2 * 1024 * 1024)

      for (let index = 0; index < 60; index++) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: aggregateID,
          messageID: SessionMessage.ID.make(`msg_large_${String(index).padStart(2, "0")}`),
          timestamp: DateTime.makeUnsafe(0),
          text: rowText,
        })
      }

      const codec = EventV2.codecCache.get(SessionEvent.ContextUpdated)
      if (!codec) throw new Error("Expected the durable event codec to be cached after publishing")
      let decodedRows = 0
      EventV2.codecCache.set(SessionEvent.ContextUpdated, {
        encode: codec.encode,
        decode: (input) => {
          decodedRows++
          return codec.decode(input)
        },
      })

      const received = yield* Effect.gen(function* () {
        return Array.from(yield* events.durable({ aggregateID }).pipe(Stream.take(3), Stream.runCollect))
      }).pipe(Effect.ensuring(Effect.sync(() => EventV2.codecCache.set(SessionEvent.ContextUpdated, codec))))

      const pageBytes = received.reduce(
        (total, event) => total + new TextEncoder().encode(JSON.stringify(event.data)).byteLength,
        0,
      )
      expect(received).toHaveLength(3)
      expect(pageBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(decodedRows).toBe(received.length)
      expect(decodedRows).toBeLessThan(60)
    }),
  )

  it.effect("includes events published while a historical page drain is in flight", () =>
    Effect.gen(function* () {
      let reads = 0
      const secondReadStarted = yield* Deferred.make<void>()
      const releaseSecondRead = yield* Deferred.make<void>()
      readHook.current = () =>
        Effect.gen(function* () {
          reads++
          if (reads === 2) {
            yield* Deferred.succeed(secondReadStarted, undefined)
            yield* Deferred.await(releaseSecondRead)
          }
        })
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      for (let index = 0; index < 101; index++) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: aggregateID,
          messageID: SessionMessage.ID.make(`msg_initial_${String(index).padStart(3, "0")}`),
          timestamp: DateTime.makeUnsafe(0),
          text: String(index),
        })
      }

      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(104), Stream.runCollect, Effect.forkScoped)
      yield* Deferred.await(secondReadStarted)
      for (let index = 101; index < 104; index++) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: aggregateID,
          messageID: SessionMessage.ID.make(`msg_late_${String(index).padStart(3, "0")}`),
          timestamp: DateTime.makeUnsafe(0),
          text: String(index),
        })
      }
      yield* Deferred.succeed(releaseSecondRead, undefined)

      const received = Array.from(yield* Fiber.join(fiber))
      expect(received.map((event) => event.durable?.seq)).toEqual(Array.from({ length: 104 }, (_, index) => index))
      expect(new Set(received.map((event) => event.id)).size).toBe(104)
    }),
  )

  it.effect("serializes simultaneous durable wakes behind one page drain", () =>
    Effect.gen(function* () {
      let reads = 0
      let activeReads = 0
      let maxActiveReads = 0
      const liveReadStarted = yield* Deferred.make<void>()
      const releaseLiveRead = yield* Deferred.make<void>()
      readHook.current = () =>
        Effect.gen(function* () {
          reads++
          activeReads++
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          yield* reads === 2
            ? Deferred.succeed(liveReadStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseLiveRead)))
            : Effect.void
          activeReads--
        })
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID: aggregateID,
        messageID: SessionMessage.ID.make("msg_seed"),
        timestamp: DateTime.makeUnsafe(0),
        text: "seed",
      })

      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* events.publish(SessionEvent.ContextUpdated, {
        sessionID: aggregateID,
        messageID: SessionMessage.ID.make("msg_live_1"),
        timestamp: DateTime.makeUnsafe(0),
        text: "one",
      })
      yield* Deferred.await(liveReadStarted)
      for (const value of ["two", "three"]) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: aggregateID,
          messageID: SessionMessage.ID.make(`msg_live_${value}`),
          timestamp: DateTime.makeUnsafe(0),
          text: value,
        })
      }
      yield* Deferred.succeed(releaseLiveRead, undefined)

      const received = Array.from(yield* Fiber.join(fiber))
      expect(received.map((event) => event.durable?.seq)).toEqual([0, 1, 2, 3])
      expect(maxActiveReads).toBe(1)
    }),
  )

  itSession.effect("restarts durable streams from sequence zero", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location: sessionLocation })
      for (const value of ["one", "two"]) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: created.id,
          messageID: SessionMessage.ID.make(`msg_${value}`),
          timestamp: DateTime.makeUnsafe(0),
          text: value,
        })
      }

      const durableFirst = Array.from(
        yield* events.durable({ aggregateID: created.id }).pipe(Stream.take(2), Stream.runCollect),
      )
      const durableSecond = Array.from(
        yield* events.durable({ aggregateID: created.id }).pipe(Stream.take(2), Stream.runCollect),
      )
      const sessionFirst = Array.from(
        yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect),
      )
      const sessionSecond = Array.from(
        yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect),
      )

      expect(durableFirst.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(durableSecond.map((event) => event.durable?.seq)).toEqual([0, 1])
      expect(sessionFirst.map((event) => event.durable?.seq)).toEqual([1, 2])
      expect(sessionSecond.map((event) => event.durable?.seq)).toEqual([1, 2])
    }),
  )
})
