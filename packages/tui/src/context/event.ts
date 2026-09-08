import type { Event } from "@opencode-ai/sdk/v2"
import { getOwner, onCleanup } from "solid-js"
import { useSDK } from "./sdk"

type EventMetadata = {
  directory: string
  workspace: string | undefined
}

export function useEvent() {
  const sdk = useSDK()

  function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
    const unsubscribe = sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      handler(event.payload, { directory: event.directory, workspace: event.workspace })
    })
    // Fork(lowmem): the emitter's handler set is process-global; dispose with
    // the subscribing scope so per-mount subscribers don't leak across keyed
    // remounts. Ownerless subscriptions keep the manual-unsubscribe lifetime.
    if (getOwner()) onCleanup(unsubscribe)
    return unsubscribe
  }

  function on<T extends Event["type"]>(
    type: T,
    handler: (event: Extract<Event, { type: T }>, metadata: EventMetadata) => void,
  ) {
    return subscribe((event: Event, metadata: EventMetadata) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>, metadata)
    })
  }

  return {
    subscribe,
    on,
  }
}
