export * as MessageSelection from "./message-selection"

import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm"
import { NotFoundError } from "@/storage/storage"
import { MessageID, SessionID } from "./schema"

type Cursor = {
  readonly id: MessageID
  readonly time: number
}

type MessageRow = typeof MessageTable.$inferSelect

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

const newer = (row: Cursor) =>
  or(gt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), gt(MessageTable.id, row.id)))

const atOrBefore = (row: Cursor) =>
  or(older(row), and(eq(MessageTable.time_created, row.time), eq(MessageTable.id, row.id)))

export const turnRows = Effect.fn("MessageSelection.turnRows")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
}) {
  const { db } = yield* Database.Service
  const target = yield* db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!target) {
    const session = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return []
  }

  return yield* db
    .select()
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, input.sessionID),
        sql`(${MessageTable.id} = ${input.messageID} OR (json_extract(${MessageTable.data}, '$.role') = 'assistant' AND json_extract(${MessageTable.data}, '$.parentID') = ${input.messageID}))`,
      ),
    )
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)
})

export const forEachBeforeRows = Effect.fn("MessageSelection.forEachBeforeRows")(function* (input: {
  sessionID: SessionID
  messageID?: MessageID
  each: (rows: MessageRow[]) => Effect.Effect<void>
}) {
  const { db } = yield* Database.Service
  const upper = yield* db
    .select({ id: MessageTable.id, time: MessageTable.time_created })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, input.sessionID))
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!upper) return

  const boundary = input.messageID
    ? yield* db
        .select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable)
        .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  const size = 50
  let after: Cursor | undefined

  while (true) {
    const rows = yield* db
      .select()
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, input.sessionID),
          atOrBefore(upper),
          boundary ? older(boundary) : undefined,
          after ? newer(after) : undefined,
        ),
      )
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .limit(size + 1)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return

    const page = rows.slice(0, size)
    yield* input.each(page)
    if (rows.length <= size) return
    const last = page.at(-1)
    if (!last) return
    after = { id: last.id, time: last.time_created }
  }
})
