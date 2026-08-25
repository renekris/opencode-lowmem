export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"
import { EnvLimit } from "./util/env-limit"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  readonly id: string
  readonly type: string
  readonly title?: string
  readonly status: Status
  readonly started_at: number
  readonly completed_at?: number
  readonly output?: string
  readonly error?: string
  readonly metadata?: Record<string, unknown>
}

/**
 * Waiting returns either an available running/terminal snapshot or an explicit
 * expiry after count eviction. A removed entry never fabricates terminal info.
 */
export type WaitResult =
  | {
      readonly status: "available"
      readonly info?: Info
      readonly timedOut: boolean
    }
  | {
      readonly status: "expired"
      readonly info?: undefined
      readonly timedOut: false
    }

export type Inspection = {
  readonly entryCount: number
  readonly runningCount: number
  readonly settledCount: number
  readonly settledOutputBytes: number
  readonly evictions: number
  readonly outputStrips: number
  readonly waiters: number
  readonly settledResources: {
    readonly deferreds: number
    readonly scopes: number
    readonly tokens: number
  }
}

type Active = {
  readonly kind: "active"
  readonly info: Info
  readonly done: Deferred.Deferred<Info>
  readonly scope: Scope.Closeable
  readonly token: object
  readonly pending: number
  readonly next: number
  readonly output?: { readonly sequence: number; readonly text: string }
  readonly tail: Deferred.Deferred<void>
  readonly promoted: Deferred.Deferred<Info>
  readonly onPromote?: Effect.Effect<void>
  readonly waiters: number
}

// Only Active entries retain execution resources. Terminal entries contain plain
// metadata and are the sole members of the bounded settled ring.
type Terminal = {
  readonly kind: "terminal"
  readonly info: Info
}

type Entry = Active | Terminal

type Registry = {
  readonly entries: Map<string, Entry>
  readonly settled: readonly string[]
  readonly settledOutputBytes: number
  readonly evictions: number
  readonly outputStrips: number
  readonly waiters: number
  readonly lastWarningAt?: number
}

type State = {
  registry: SynchronizedRef.SynchronizedRef<Registry>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  warning?: PressureWarning
}

type PromoteResult = {
  info?: Info
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info | undefined>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

type PressureWarning = {
  readonly component: "background-job"
  readonly budget: "settled-ring"
  readonly evictableResident: number
  readonly protectedResident: 0
  readonly count: number
  readonly evictions: number
  readonly truncations: number
  readonly jobID: string
}

type RingConfig = {
  readonly maxSettled: number
  readonly maxOutputBytes: number
}

type WaitReservation =
  | { readonly kind: "expired" }
  | { readonly kind: "available"; readonly info: Info; readonly timedOut: boolean }
  | { readonly kind: "running"; readonly done: Deferred.Deferred<Info>; readonly token: object }

const SETTLED_MAX = "100"
const SETTLED_OUTPUT_MAX_MB = "8MB"
const WARNING_INTERVAL = 60_000
const textEncoder = new TextEncoder()

function snapshot(info: Info): Info {
  return {
    ...info,
    ...(info.metadata ? { metadata: { ...info.metadata } } : {}),
  }
}

function snapshotEntry(entry: Entry): Info {
  return snapshot(entry.info)
}

function outputBytes(info: Info) {
  return info.output === undefined ? 0 : textEncoder.encode(info.output).byteLength
}

function stripOutput(info: Info): Info {
  const copy = { ...info }
  delete copy.output
  return copy
}

function ringConfig(): RingConfig {
  return {
    maxSettled: EnvLimit.readEnvLimit("OPENCODE_BGJOB_SETTLED_MAX", SETTLED_MAX, "count"),
    maxOutputBytes: EnvLimit.readEnvLimit("OPENCODE_BGJOB_SETTLED_OUTPUT_MAX_MB", SETTLED_OUTPUT_MAX_MB, "bytes"),
  }
}

function putEntry(registry: Registry, id: string, entry: Entry): Registry {
  const previous = registry.entries.get(id)
  const entries = new Map(registry.entries).set(id, entry)
  if (previous?.kind !== "terminal") return { ...registry, entries }

  return {
    ...registry,
    entries,
    settled: registry.settled.filter((settledID) => settledID !== id),
    settledOutputBytes: registry.settledOutputBytes - outputBytes(previous.info),
  }
}

type RingResult = {
  readonly registry: Registry
  readonly warning?: PressureWarning
}

function retainTerminal(registry: Registry, id: string, info: Info, config: RingConfig, now: number): RingResult {
  const base = putEntry(registry, id, { kind: "terminal", info })
  const entries = new Map(base.entries)
  const settled = [...base.settled, id]
  let settledOutputBytes = base.settledOutputBytes + outputBytes(info)
  let outputStrips = base.outputStrips
  let evictions = base.evictions
  let pressure = false

  const stripOverage = (ids: readonly string[]) => {
    if (config.maxOutputBytes <= 0 || settledOutputBytes <= config.maxOutputBytes) return
    pressure = true
    for (const settledID of ids) {
      if (settledOutputBytes <= config.maxOutputBytes) break
      const entry = entries.get(settledID)
      if (entry?.kind !== "terminal" || entry.info.output === undefined) continue
      settledOutputBytes -= outputBytes(entry.info)
      entries.set(settledID, { kind: "terminal", info: stripOutput(entry.info) })
      outputStrips += 1
    }
  }

  stripOverage(settled)

  const countPressure = config.maxSettled > 0 && settled.length > config.maxSettled
  if (countPressure) {
    pressure = true
    for (const expiredID of settled.slice(0, settled.length - config.maxSettled)) {
      const entry = entries.get(expiredID)
      if (entry?.kind !== "terminal") continue
      settledOutputBytes -= outputBytes(entry.info)
      entries.delete(expiredID)
      evictions += 1
    }
  }

  const retained = countPressure ? settled.slice(settled.length - config.maxSettled) : settled
  stripOverage(retained)

  const shouldWarn = pressure && (base.lastWarningAt === undefined || now - base.lastWarningAt >= WARNING_INTERVAL)
  const next: Registry = {
    ...base,
    entries,
    settled: retained,
    settledOutputBytes,
    evictions,
    outputStrips,
    ...(shouldWarn ? { lastWarningAt: now } : {}),
  }
  if (!shouldWarn) return { registry: next }
  return {
    registry: next,
    warning: {
      component: "background-job",
      budget: "settled-ring",
      evictableResident: settledOutputBytes,
      protectedResident: 0,
      count: retained.length,
      evictions,
      truncations: outputStrips,
      jobID: id,
    },
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  const config = ringConfig()
  const state: State = {
    registry: yield* SynchronizedRef.make<Registry>({
      entries: new Map(),
      settled: [],
      settledOutputBytes: 0,
      evictions: 0,
      outputStrips: 0,
      waiters: 0,
    }),
    scope: yield* Scope.Scope,
  }

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.registry,
      Effect.fnUntraced(function* (registry) {
        const entry = registry.entries.get(id)
        if (!entry || entry.kind !== "active") return [{} satisfies FinishResult, registry] as const
        if (entry.token !== token) return [{} satisfies FinishResult, registry] as const

        const pending = entry.pending - 1
        const output =
          Exit.isSuccess(exit) && (!entry.output || sequence > entry.output.sequence)
            ? { sequence, text: exit.value }
            : entry.output
        if (Exit.isSuccess(exit) && pending > 0) {
          return [
            {} satisfies FinishResult,
            { ...registry, entries: new Map(registry.entries).set(id, { ...entry, pending, output }) },
          ] as const
        }

        const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
        const info: Info = {
          ...entry.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        }

        yield* Deferred.succeed(entry.done, info).pipe(Effect.ignore)
        yield* Deferred.succeed(entry.promoted, info).pipe(Effect.ignore)
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))

        const retained = retainTerminal(registry, id, info, config, completed_at)
        const finished: FinishResult = {
          info: snapshot(info),
          ...(retained.warning ? { warning: retained.warning } : {}),
        }
        return [finished, retained.registry] as const
      }),
    )
    if (result.warning) yield* Effect.logWarning("background-job settlement pressure", result.warning)
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.registry)).entries.values())
      .map(snapshotEntry)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const entry = (yield* SynchronizedRef.get(state.registry)).entries.get(id)
    if (!entry) return
    return snapshotEntry(entry)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.registry,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.entries.get(id)
            if (existing?.kind === "active") {
              return [{ info: snapshot(existing.info) }, jobs] as readonly [StartResult, Registry]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job: Active = {
              kind: "active",
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
              },
              done,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
              waiters: 0,
            }
            return [{ info: snapshot(job.info), scope, token }, putEntry(jobs, id, job)] as readonly [StartResult, Registry]
          }),
        )
        if ("scope" in result)
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(
          state.registry,
          (jobs): readonly [ExtendResult, Registry] => {
            const job = jobs.entries.get(input.id)
            if (!job || job.kind !== "active") return [{ extended: false }, jobs]
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              {
                ...jobs,
                entries: new Map(jobs.entries).set(input.id, {
                  ...job,
                  pending: job.pending + 1,
                  next: job.next + 1,
                  tail,
                }),
              },
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const reservation = yield* SynchronizedRef.modify(
      state.registry,
      (registry): readonly [WaitReservation, Registry] => {
        const entry = registry.entries.get(input.id)
        if (!entry) return [{ kind: "expired" }, registry]
        if (entry.kind === "terminal") return [{ kind: "available", info: snapshot(entry.info), timedOut: false }, registry]
        if (input.timeout !== undefined && input.timeout <= 0)
          return [{ kind: "available", info: snapshot(entry.info), timedOut: true }, registry]
        return [
          { kind: "running", done: entry.done, token: entry.token },
          {
            ...registry,
            waiters: registry.waiters + 1,
            entries: new Map(registry.entries).set(input.id, { ...entry, waiters: entry.waiters + 1 }),
          },
        ]
      },
    )
    if (reservation.kind === "expired") {
      const expired: WaitResult = { status: "expired", timedOut: false }
      return expired
    }
    if (reservation.kind === "available")
      return { status: "available", info: reservation.info, timedOut: reservation.timedOut }

    const decrement = SynchronizedRef.update(state.registry, (registry) => {
      const entry = registry.entries.get(input.id)
      return {
        ...registry,
        waiters: registry.waiters - 1,
        ...(entry?.kind === "active" && entry.token === reservation.token
          ? { entries: new Map(registry.entries).set(input.id, { ...entry, waiters: entry.waiters - 1 }) }
          : {}),
      }
    })
    const waited = input.timeout === undefined
      ? Deferred.await(reservation.done).pipe(
          Effect.map((info) => ({ status: "available" as const, info: snapshot(info), timedOut: false })),
        )
      : Deferred.await(reservation.done).pipe(
          Effect.timeoutOption(input.timeout),
          Effect.flatMap((info) => {
            if (info._tag === "Some")
              return Effect.succeed({ status: "available" as const, info: snapshot(info.value), timedOut: false })
            return SynchronizedRef.get(state.registry).pipe(
              Effect.map((registry) => {
                const entry = registry.entries.get(input.id)
                if (!entry) return { status: "expired" as const, timedOut: false as const }
                return { status: "available" as const, info: snapshotEntry(entry), timedOut: true }
              }),
            )
          }),
        )
    return yield* waited.pipe(Effect.ensuring(decrement))
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const entry = (yield* SynchronizedRef.get(state.registry)).entries.get(id)
    if (!entry) return
    if (entry.kind === "terminal") return snapshot(entry.info)
    if (entry.info.metadata?.background === true) return snapshot(entry.info)
    return yield* Deferred.await(entry.promoted).pipe(Effect.map(snapshot))
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.registry,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.entries.get(id)
        if (!job || job.kind !== "active") return [{} satisfies PromoteResult, jobs] as const
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job.info) } satisfies PromoteResult, jobs] as const
        const next: Active = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        const info = snapshot(next.info)
        yield* Deferred.succeed(job.promoted, info).pipe(Effect.ignore)
        const promoted: PromoteResult = { info, onPromote: job.onPromote }
        return [
          promoted,
          { ...jobs, entries: new Map(jobs.entries).set(id, next) },
        ] as readonly [PromoteResult, Registry]
      }),
    )
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.registry,
      Effect.fnUntraced(function* (registry) {
        const job = registry.entries.get(id)
        if (!job) return [{} satisfies FinishResult, registry] as const
        if (job.kind !== "active") return [{ info: snapshot(job.info) } satisfies FinishResult, registry] as const

        const info: Info = { ...job.info, status: "cancelled", completed_at }
        yield* Deferred.succeed(job.done, info).pipe(Effect.ignore)
        yield* Deferred.succeed(job.promoted, info).pipe(Effect.ignore)
        yield* Scope.close(job.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))

        const retained = retainTerminal(registry, id, info, config, completed_at)
        const finished: FinishResult = {
          info: snapshot(info),
          ...(retained.warning ? { warning: retained.warning } : {}),
        }
        return [finished, retained.registry] as const
      }),
    )
    if (result.warning) yield* Effect.logWarning("background-job settlement pressure", result.warning)
    return result.info
  })

  // Instrumentation is intentionally available on make() for deterministic
  // tests; the public instance adapter only exposes the runtime contract.
  const inspect = Effect.fn("BackgroundJob.inspect")(function* () {
    const registry = yield* SynchronizedRef.get(state.registry)
    return {
      entryCount: registry.entries.size,
      runningCount: Array.from(registry.entries.values()).filter((entry) => entry.kind === "active").length,
      settledCount: registry.settled.length,
      settledOutputBytes: registry.settledOutputBytes,
      evictions: registry.evictions,
      outputStrips: registry.outputStrips,
      waiters: registry.waiters,
      settledResources: { deferreds: 0, scopes: 0, tokens: 0 },
    } satisfies Inspection
  })

  return { ...Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel }), inspect }
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
