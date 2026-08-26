/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent, Part } from "@opencode-ai/sdk/v2"
import { serializedUtf8Bytes } from "../../../../src/context/payload-budget"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function session(id: string) {
  return {
    id,
    title: id,
    slug: id,
    projectID: "proj_test",
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
  }
}

function assistant(sessionID: string, messageID: string) {
  return {
    id: messageID,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: `${messageID}_user`,
    path: { cwd: "/tmp/opencode/packages/opencode", root: "/tmp/opencode/packages/opencode" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
  }
}

test("buffered text and reasoning deltas retain exact serialized resident bytes", async () => {
  // Given: a live assistant message with empty text and reasoning parts.
  const sessionID = "ses_incremental_buffered"
  const messageID = "msg_incremental_buffered"
  const textPart = {
    id: "prt_incremental_text",
    sessionID,
    messageID,
    type: "text",
    text: "",
  } satisfies Part
  const reasoningPart = {
    id: "prt_incremental_reasoning",
    sessionID,
    messageID,
    type: "reasoning",
    text: "",
    time: { start: 1 },
  } satisfies Part
  const message = assistant(sessionID, messageID)
  const finalTextPart = { ...textPart, text: `Hello ${String.fromCodePoint(34)}quoted${String.fromCodePoint(34)}\\\né` }
  const finalReasoningPart = { ...reasoningPart, text: "thinking \uD83D\uDE00" }
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_incremental_session",
        type: "session.updated",
        properties: { sessionID, info: session(sessionID) },
      }),
    )
    emit(global({ id: "evt_incremental_message", type: "message.updated", properties: { sessionID, info: message } }))
    emit(
      global({
        id: "evt_incremental_text_part",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: textPart },
      }),
    )
    emit(
      global({
        id: "evt_incremental_reasoning_part",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: reasoningPart },
      }),
    )
    await wait(() => sync.data.part[messageID]?.length === 2)

    // When: the real sync path receives multiple deltas before its coalescing flush.
    for (const [index, delta] of [
      "Hello ",
      String.fromCodePoint(34),
      "quoted",
      String.fromCodePoint(34),
      "\\",
      "\n",
      "é",
    ].entries())
      emit(
        global({
          id: `evt_incremental_text_${index}`,
          type: "message.part.delta",
          properties: { sessionID, messageID, partID: textPart.id, field: "text", delta },
        }),
      )
    for (const [index, delta] of ["thinking ", "\uD83D", "\uDE00"].entries())
      emit(
        global({
          id: `evt_incremental_reasoning_${index}`,
          type: "message.part.delta",
          properties: { sessionID, messageID, partID: reasoningPart.id, field: "text", delta },
        }),
      )
    await wait(
      () =>
        (sync.data.part[messageID]?.some(
          (part) => part.id === textPart.id && part.type === "text" && part.text === finalTextPart.text,
        ) ??
          false) &&
        (sync.data.part[messageID]?.some(
          (part) => part.id === reasoningPart.id && part.type === "reasoning" && part.text === finalReasoningPart.text,
        ) ??
          false),
    )

    // Then: resident accounting equals serialization of the final message and both final parts.
    expect(sync.payload.stats().evictableResident + sync.payload.stats().protectedResident).toBe(
      serializedUtf8Bytes(message) + serializedUtf8Bytes(finalTextPart) + serializedUtf8Bytes(finalReasoningPart),
    )
  } finally {
    app.renderer.destroy()
  }
})

test("authoritative part replacement retains full serialized accounting", async () => {
  // Given: a live text part with an already streamed value.
  const sessionID = "ses_incremental_replacement"
  const messageID = "msg_incremental_replacement"
  const initialPart = {
    id: "prt_incremental_replacement",
    sessionID,
    messageID,
    type: "text",
    text: "streamed",
  } satisfies Part
  const replacementPart = { ...initialPart, text: "authoritative replacement" }
  const message = assistant(sessionID, messageID)
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    emit(
      global({
        id: "evt_replacement_session",
        type: "session.updated",
        properties: { sessionID, info: session(sessionID) },
      }),
    )
    emit(global({ id: "evt_replacement_message", type: "message.updated", properties: { sessionID, info: message } }))
    emit(
      global({
        id: "evt_replacement_initial_part",
        type: "message.part.updated",
        properties: { sessionID, time: 1, part: initialPart },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    // When: an authoritative replacement arrives instead of an append-only delta.
    emit(
      global({
        id: "evt_replacement_final_part",
        type: "message.part.updated",
        properties: { sessionID, time: 2, part: replacementPart },
      }),
    )
    await wait(
      () =>
        sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text === replacementPart.text,
    )

    // Then: full replacement accounting remains equal to the independent serialized final part.
    expect(sync.payload.stats().evictableResident + sync.payload.stats().protectedResident).toBe(
      serializedUtf8Bytes(message) + serializedUtf8Bytes(replacementPart),
    )
  } finally {
    app.renderer.destroy()
  }
})
