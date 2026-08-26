import { describe, expect, spyOn, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { createPayloadBudget, serializedUtf8Bytes } from "../../src/context/payload-budget"

type AppendablePart = Extract<Part, { type: "text" | "reasoning" }>

function textPart(id: string, text: string): Extract<Part, { type: "text" }> {
  return { id, sessionID: "ses_incremental", messageID: "msg_incremental", type: "text", text }
}

function reasoningPart(id: string, text: string): Extract<Part, { type: "reasoning" }> {
  return {
    id,
    sessionID: "ses_incremental",
    messageID: "msg_incremental",
    type: "reasoning",
    text,
    time: { start: 1 },
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected appendable part: ${String(value)}`)
}

function withText(part: AppendablePart, text: string): AppendablePart {
  switch (part.type) {
    case "text":
      return { ...part, text }
    case "reasoning":
      return { ...part, text }
    default:
      return assertNever(part)
  }
}

const genericControls = String.fromCodePoint(...Array.from({ length: 32 }, (_, codePoint) => codePoint))

const appendCases = [
  { name: "ASCII", part: textPart("prt_ascii", ""), chunks: ["plain ASCII"] },
  {
    name: "quotes",
    part: textPart("prt_quotes", ""),
    chunks: [`quote ${String.fromCodePoint(34)}value${String.fromCodePoint(34)}`],
  },
  {
    name: "backslashes",
    part: textPart("prt_backslashes", ""),
    chunks: [`path ${String.fromCodePoint(92)}server${String.fromCodePoint(92)}share`],
  },
  { name: "short controls", part: textPart("prt_short_controls", ""), chunks: ["\b\f\n\r\t"] },
  { name: "generic controls", part: textPart("prt_generic_controls", ""), chunks: [genericControls] },
  { name: "multibyte Unicode", part: textPart("prt_multibyte", ""), chunks: ["é€漢字"] },
  { name: "lone high surrogate", part: textPart("prt_high", ""), chunks: ["\uD800"] },
  { name: "lone low surrogate", part: textPart("prt_low", ""), chunks: ["\uDC00"] },
  { name: "valid surrogate pair", part: textPart("prt_pair", ""), chunks: ["\uD83D\uDE00"] },
  { name: "surrogate pair split across chunks", part: textPart("prt_split_pair", ""), chunks: ["\uD83D", "\uDE00"] },
  {
    name: "mixed multi-flush reasoning",
    part: reasoningPart("prt_mixed_reasoning", "seed"),
    chunks: [" ASCII", String.fromCodePoint(34), String.fromCodePoint(92), "\n", "é", "\uD83D", "\uDE00", "終"],
  },
] satisfies readonly { readonly name: string; readonly part: AppendablePart; readonly chunks: readonly string[] }[]

describe("incremental payload accounting", () => {
  for (const testCase of appendCases) {
    test(`matches serialized bytes for ${testCase.name} append flushes`, () => {
      // Given: an admitted text or reasoning part with its authoritative resident bytes.
      const budget = createPayloadBudget()
      let previousPart = testCase.part
      budget.replacePart(
        previousPart.messageID,
        previousPart.id,
        previousPart.sessionID,
        previousPart,
        serializedUtf8Bytes(previousPart),
      )

      // When: each buffered append flush is prepared incrementally and admitted.
      for (const chunk of testCase.chunks) {
        const finalPart = withText(previousPart, previousPart.text + chunk)
        const prepared = budget.preparePartAppend(finalPart.sessionID, previousPart, chunk)
        budget.replacePart(
          finalPart.messageID,
          finalPart.id,
          finalPart.sessionID,
          prepared.part,
          prepared.measuredBytes,
        )

        // Then: accounting is byte-for-byte equivalent to the independently serialized final part.
        expect(prepared.part).toEqual(finalPart)
        expect(prepared.measuredBytes).toBe(serializedUtf8Bytes(finalPart))
        expect(budget.sessionBytes(finalPart.sessionID)).toBe(serializedUtf8Bytes(finalPart))
        previousPart = finalPart
      }
    })
  }

  test("falls back to authoritative preparation and truncates an append over the scalar cap", () => {
    // Given: an admitted part whose next append would exceed the scalar ingress limit.
    const previousPart = textPart("prt_cap_fallback", "seed")
    const appendedText = " plus content over the cap"
    const finalPart = withText(previousPart, previousPart.text + appendedText)
    const budget = createPayloadBudget({ partIngressBytes: serializedUtf8Bytes(previousPart.text) })
    budget.replacePart(
      previousPart.messageID,
      previousPart.id,
      previousPart.sessionID,
      previousPart,
      serializedUtf8Bytes(previousPart),
    )

    // When: the append-only preparation is asked to cross that cap.
    const prepared = budget.preparePartAppend(finalPart.sessionID, previousPart, appendedText)

    // Then: full preparePart truncation remains authoritative and its measured bytes stay exact.
    expect(prepared.part).not.toBe(finalPart)
    expect(prepared.part.type).toBe("text")
    if (prepared.part.type !== "text") return
    expect(prepared.part.text).toContain("payload omitted by lowmem budget")
    expect(prepared.measuredBytes).toBe(serializedUtf8Bytes(prepared.part))
    budget.replacePart(finalPart.messageID, finalPart.id, finalPart.sessionID, prepared.part, prepared.measuredBytes)
    expect(budget.sessionBytes(finalPart.sessionID)).toBe(serializedUtf8Bytes(prepared.part))
  })

  test("does not serialize the complete part for an admitted append", () => {
    const previousPart = textPart("prt_no_full_serialize", "seed")
    const budget = createPayloadBudget()
    budget.replacePart(
      previousPart.messageID,
      previousPart.id,
      previousPart.sessionID,
      previousPart,
      serializedUtf8Bytes(previousPart),
    )
    const stringify = spyOn(JSON, "stringify")

    try {
      const prepared = budget.preparePartAppend(previousPart.sessionID, previousPart, " appended")
      expect(stringify).toHaveBeenCalledTimes(0)
      expect(prepared.measuredBytes).toBe(serializedUtf8Bytes(prepared.part))
    } finally {
      stringify.mockRestore()
    }
  })

  test("uses full preparation for an authoritative replacement outside the append contract", () => {
    // Given: a resident streamed part and a replacement that is not its append continuation.
    const previousPart = textPart("prt_replacement_fallback", "streamed")
    const finalPart = withText(previousPart, "authoritative replacement")
    const budget = createPayloadBudget()
    budget.replacePart(
      previousPart.messageID,
      previousPart.id,
      previousPart.sessionID,
      previousPart,
      serializedUtf8Bytes(previousPart),
    )

    // When: the authoritative replacement uses the existing full preparation path.
    const prepared = budget.preparePart(finalPart.sessionID, finalPart)
    budget.replacePart(finalPart.messageID, finalPart.id, finalPart.sessionID, prepared.part, prepared.measuredBytes)

    // Then: the authoritative replacement and its independently serialized bytes are retained.
    expect(prepared.part).toEqual(finalPart)
    expect(prepared.measuredBytes).toBe(serializedUtf8Bytes(finalPart))
    expect(budget.sessionBytes(finalPart.sessionID)).toBe(serializedUtf8Bytes(finalPart))
  })
})
