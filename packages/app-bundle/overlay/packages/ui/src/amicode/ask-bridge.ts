import { createSignal } from "solid-js"

// AMICODE: module-level bridge between the app-side send path (registered by
// AmicodeEntityRail, which the app mounts with an onAsk callback wired to
// sdk.client.session.promptAsync) and the AmicodeAskCard instances rendered
// deep inside the message-part dispatch, where no app context is reachable.
// When no bridge is registered (share page, headless), ask buttons render
// disabled — questions never submit from read-only surfaces.

export interface AskBridge {
  send: (text: string) => void
  // True when a USER message exists later (ULID order) than the given message
  // — i.e. the question has already been answered. Assistant messages after
  // the ask must not lock the card.
  hasUserReplyAfter: (messageID: string) => boolean
}

const [current, setCurrent] = createSignal<AskBridge | undefined>(undefined)

export const amicodeAskBridge = current

export function registerAmicodeAskBridge(bridge: AskBridge): () => void {
  setCurrent(bridge)
  return () => {
    if (current() === bridge) setCurrent(undefined)
  }
}
