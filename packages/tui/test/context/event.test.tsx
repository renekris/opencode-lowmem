import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createComputed, createComponent, createRoot, createSignal, Show } from "solid-js"
import { useEvent } from "../../src/context/event"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { eventSource } from "../fixture/tui-sdk"

type EventApi = ReturnType<typeof useEvent>

function globalEvent(text: string): GlobalEvent {
  return {
    directory: "/tmp/opencode/packages/tui",
    payload: { id: "evt_test", type: "tui.prompt.append", properties: { text } },
  }
}

function SdkProbe(props: { onReady: (emit: (event: GlobalEvent) => void) => void }) {
  const sdk = useSDK()
  props.onReady((event) => sdk.event.emit("event", event))
  return null
}

// Mirrors the session route and prompt subscribers: subscribe during setup and
// discard the unsubscribe handle, so disposal has to come from the owner.
function MountedSubscriber(
  props: {
    id: string
    onEvent: (id: string) => void
    onSubscribed: (api: EventApi, unsubscribe: () => void) => void
  },
) {
  const event = useEvent()
  const unsubscribe = event.on("tui.prompt.append", () => props.onEvent(props.id))
  props.onSubscribed(event, unsubscribe)
  return null
}

// Mirrors re-subscription inside a rerunning computation: each rerun must drop
// the previous computation's subscription instead of stacking handlers.
function ComputedSubscriber(props: { version: () => string; onEvent: (tag: string) => void }) {
  const event = useEvent()
  createComputed(() => {
    const tag = props.version()
    event.on("tui.prompt.append", () => props.onEvent(tag))
  })
  return null
}

function mountSubscriberTree() {
  const received: string[] = []
  const computedReceived: string[] = []
  const handles: {
    emit?: (event: GlobalEvent) => void
    setSessionID?: (id: string | undefined) => void
    setVersion?: (version: string) => void
    subscribed?: { api: EventApi; unsubscribe: () => void }
  } = {}

  const dispose = createRoot((dispose) => {
    const [sessionID, setSessionID] = createSignal<string | undefined>()
    const [version, setVersion] = createSignal("v0")
    createComponent(SDKProvider, {
      url: "http://test",
      events: eventSource(),
      get children() {
        return [
          createComponent(SdkProbe, {
            onReady: (next) => {
              handles.emit = next
            },
          }),
          createComponent(ComputedSubscriber, {
            version,
            onEvent: (tag) => computedReceived.push(tag),
          }),
          <Show when={sessionID()} keyed>
            {(id) =>
              createComponent(MountedSubscriber, {
                id,
                onEvent: (subscriberID) => received.push(subscriberID),
                onSubscribed: (api, unsubscribe) => {
                  handles.subscribed = { api, unsubscribe }
                },
              })}
          </Show>,
        ]
      },
    })
    handles.setSessionID = setSessionID
    handles.setVersion = setVersion
    return dispose
  })

  const emit = handles.emit
  const setSessionID = handles.setSessionID
  const setVersion = handles.setVersion
  if (!emit || !setSessionID || !setVersion) {
    dispose()
    throw new Error("subscriber tree setup failed: SDK probe did not mount")
  }

  return {
    received,
    computedReceived,
    dispose,
    dispatch: (text: string) => emit(globalEvent(text)),
    setSessionID,
    setVersion,
    subscribed: () => {
      const current = handles.subscribed
      if (!current) throw new Error("no subscriber mounted: set a session id before reading the subscription handle")
      return current
    },
  }
}

test("subscriptions dispose with their owner across keyed remounts; dispatch reaches only the live mount", () => {
  const tree = mountSubscriberTree()
  try {
    tree.setSessionID("ses_a")
    tree.dispatch("one")
    tree.setSessionID("ses_b")
    tree.dispatch("two")
    tree.setSessionID("ses_c")
    tree.dispatch("three")
    expect(tree.received).toEqual(["ses_a", "ses_b", "ses_c"])

    tree.dispose()
    tree.dispatch("four")
    expect(tree.received).toEqual(["ses_a", "ses_b", "ses_c"])
  } finally {
    tree.dispose()
  }
})

test("manual unsubscribe removes the handler immediately", () => {
  const tree = mountSubscriberTree()
  try {
    tree.setSessionID("ses_a")
    tree.dispatch("one")
    expect(tree.received).toEqual(["ses_a"])

    tree.subscribed().unsubscribe()
    tree.dispatch("two")
    expect(tree.received).toEqual(["ses_a"])
  } finally {
    tree.dispose()
  }
})

test("a rerunning computation drops its previous subscription on each rerun", () => {
  const tree = mountSubscriberTree()
  try {
    tree.dispatch("one")
    tree.setVersion("v1")
    tree.dispatch("two")
    tree.setVersion("v2")
    tree.dispatch("three")
    expect(tree.computedReceived).toEqual(["v0", "v1", "v2"])
  } finally {
    tree.dispose()
  }
})

test("ownerless subscriptions survive subscriber disposal until manual unsubscribe", () => {
  const tree = mountSubscriberTree()
  try {
    tree.setSessionID("ses_a")
    const api = tree.subscribed().api

    const ownerlessOn: string[] = []
    const ownerlessSubscribe: string[] = []
    const unsubscribeOn = api.on("tui.prompt.append", (evt) => ownerlessOn.push(evt.properties.text))
    const unsubscribeSubscribe = api.subscribe((event) => {
      if (event.type !== "tui.prompt.append") return
      ownerlessSubscribe.push(event.properties.text)
    })

    tree.setSessionID(undefined)
    tree.dispatch("one")
    expect(ownerlessOn).toEqual(["one"])
    expect(ownerlessSubscribe).toEqual(["one"])

    unsubscribeOn()
    tree.dispatch("two")
    expect(ownerlessOn).toEqual(["one"])
    expect(ownerlessSubscribe).toEqual(["one", "two"])

    unsubscribeSubscribe()
    tree.dispatch("three")
    expect(ownerlessSubscribe).toEqual(["one", "two"])
  } finally {
    tree.dispose()
  }
})
