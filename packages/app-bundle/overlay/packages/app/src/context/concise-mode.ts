// amicode#1651: the composer's concise switch, held PER SESSION (in memory).
//
// The switch used to be a createSignal inside the composer controller, i.e.
// per-component-instance state: every composer remount reset it to off — the
// new-chat composer being replaced by the session composer on first send, the
// Changes tab unmounting the composer in the narrow layout, a session switch.
// Here the flag lives in a module-level store keyed by session, so a remounted
// composer reads the value back. A new chat has no session id yet: it writes
// under a DRAFT key, which the submit path promotes to the real session key
// the moment the session is created (beside the agent/model promotion).
//
// In memory by design — it resets on app reload; there is no persistence layer.
import { createStore } from "solid-js/store"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

export const conciseKey = {
  session: (scope: ServerScope, directory: string, sessionID: string): string =>
    ScopedKey.from(scope, directory, "session", sessionID),
  draft: (scope: ServerScope, directory: string, draftID: string | undefined): string =>
    ScopedKey.from(scope, directory, "draft", draftID ?? ""),
}

export type ConciseStore = ReturnType<typeof createConciseStore>

export function createConciseStore() {
  const [state, setState] = createStore<Record<string, boolean | undefined>>({})
  return {
    get: (key: string) => state[key] === true,
    set: (key: string, on: boolean) => setState(key, on),
    /** Carry a draft's value to its newly created session and drop the draft entry. */
    promote: (from: string, to: string) => {
      const value = state[from]
      if (value === undefined) return
      setState(to, value)
      setState(from, undefined)
    },
  }
}

/** The app-wide instance the composer and the submit path share. */
export const conciseMode = createConciseStore()

/** A composer's view of the flag: always reads/writes the CURRENT key. */
export function bindConcise(store: ConciseStore, key: () => string) {
  return {
    on: () => store.get(key()),
    set: (next: boolean) => store.set(key(), next),
  }
}
