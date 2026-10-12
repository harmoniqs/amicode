// The global event stream's shared frame source (#1776). One tap on the global
// bus serializes each event once, at emit, into a frame stamped with its
// `<epoch>:<seq>` id, and fans it out to every live subscription.
import { GlobalBus } from "./global"

export type Frame = {
  /** The SSE id: `<epoch>:<seq>`. */
  readonly id: string
  readonly seq: number
  /** The serialized global event — the SSE `data`. */
  readonly data: string
}

export function formatID(epoch: string, seq: number) {
  return `${epoch}:${seq}`
}

export type Subscription = {
  /** The connection's starting position: the sequence its first live frame follows. */
  readonly position: number
  /** Begin delivering live frames. */
  start(deliver: (frame: Frame) => void): void
  /** Unregister. Idempotent. */
  close(): void
}

export class FrameSource {
  readonly #listeners = new Set<(frame: Frame) => void>()

  constructor(readonly epoch: string) {}

  /** Live subscriptions currently registered. */
  get subscribers() {
    return this.#listeners.size
  }

  push(seq: number, data: string): Frame {
    const frame: Frame = { id: formatID(this.epoch, seq), seq, data }
    for (const listener of this.#listeners) listener(frame)
    return frame
  }

  subscribe(): Subscription {
    let deliver: ((frame: Frame) => void) | undefined
    const pending: Frame[] = []
    const listener = (frame: Frame) => (deliver ? deliver(frame) : pending.push(frame))
    this.#listeners.add(listener)
    return {
      position: GlobalBus.seq,
      start: (fn) => {
        for (const frame of pending.splice(0)) fn(frame)
        deliver = fn
      },
      close: () => {
        this.#listeners.delete(listener)
        pending.length = 0
      },
    }
  }
}

export const GlobalEventFrames = new FrameSource(GlobalBus.epoch)

GlobalBus.tap((event, seq) => {
  let data: string
  try {
    data = JSON.stringify(event)
  } catch (error) {
    // An unserializable event cannot be framed; its sequence becomes a hole the
    // client detects (heartbeats carry the bus sequence), never a dead stream.
    console.error("global event not serializable", { seq, type: event.payload?.type, error })
    return
  }
  GlobalEventFrames.push(seq, data)
})
