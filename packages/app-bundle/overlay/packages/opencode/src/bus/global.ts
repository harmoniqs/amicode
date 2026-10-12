import { EventEmitter } from "events"
import { randomBytes } from "crypto"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

/**
 * A pre-dispatch observer. Taps see every emitted event with its sequence
 * BEFORE any ordinary listener runs, so they observe events in strict
 * sequence order even when a listener emits from inside its handler (a nested
 * emit is sequenced and tapped only after the outer event was). A tap must not
 * throw and must not emit.
 */
export type GlobalBusTap = (event: GlobalEvent, seq: number) => void

// How many recent source-event ids are remembered so a sync copy (which the
// event-v2 bridge emits right after its source) can share the source's
// sequence. The copy follows its source immediately; the window only has to
// absorb events a listener emits in between.
const MIRROR_WINDOW = 256

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  /** Random per-process token; `<epoch>:<seq>` is a global-stream frame id (#1776). */
  readonly epoch = randomBytes(6).toString("base64url")
  #seq = 0
  #mirrors = new Map<string, number>()
  #taps = new Set<GlobalBusTap>()

  /** The current sequence: the one assigned to the last emitted event (0 before any). */
  get seq() {
    return this.#seq
  }

  /** Register a pre-dispatch tap; returns its unregister function. */
  tap(fn: GlobalBusTap): () => void {
    this.#taps.add(fn)
    return () => {
      this.#taps.delete(fn)
    }
  }

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    const seq = this.#sequence(event.payload)
    for (const tap of this.#taps) tap(event, seq)
    return super.emit(eventName, event)
  }

  // One strictly increasing counter, assigned once per event at emit and shared
  // by every subscriber. A sync copy is not a new event: it carries the
  // sequence of the event it mirrors, so filtering sync copies leaves no holes.
  #sequence(payload: any): number {
    if (payload?.type === "sync") {
      const source = typeof payload.syncEvent?.id === "string" ? this.#mirrors.get(payload.syncEvent.id) : undefined
      if (source !== undefined) return source
      return ++this.#seq
    }
    const seq = ++this.#seq
    if (typeof payload?.id === "string") {
      this.#mirrors.set(payload.id, seq)
      if (this.#mirrors.size > MIRROR_WINDOW) this.#mirrors.delete(this.#mirrors.keys().next().value!)
    }
    return seq
  }
}

export const GlobalBus = new GlobalBusEmitter()
