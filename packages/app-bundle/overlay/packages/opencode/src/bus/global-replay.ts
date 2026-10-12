// The global event stream's replay buffer (#1776). One tap on the global bus
// serializes each event once, at emit, into a frame stamped with its
// `<epoch>:<seq>` id; the buffer keeps recent frames (shared by every
// subscriber) and fans each one out to the live subscriptions. A connection
// that resumes from a cursor gets the frames after it, then live frames.
import { GlobalBus } from "./global"

export type Frame = {
  /** The SSE id: `<epoch>:<seq>`. */
  readonly id: string
  readonly seq: number
  /** The serialized global event — the SSE `data`. */
  readonly data: string
  /** Push order; unlike `seq` it is unique per frame (a sync copy shares its source's seq). */
  readonly ordinal: number
}

export function formatID(epoch: string, seq: number) {
  return `${epoch}:${seq}`
}

/** Parse an `<epoch>:<seq>` cursor; `undefined` when absent or malformed. */
export function parseCursor(raw: string | null | undefined): { epoch: string; seq: number } | undefined {
  const match = /^([A-Za-z0-9_-]+):(\d+)$/.exec(raw?.trim() ?? "")
  if (!match) return undefined
  return { epoch: match[1], seq: Number(match[2]) }
}

export type Subscription = {
  /** The connection's starting position: the sequence its first frame follows. */
  readonly position: number
  /** Frames after the cursor, in order — delivered before any live frame. */
  readonly replay: readonly Frame[]
  /** Begin delivering live frames (any that arrived since subscribing first, minus duplicates of `replay`). */
  start(deliver: (frame: Frame) => void): void
  /** Unregister. Idempotent. */
  close(): void
}

export class ReplayBuffer {
  readonly #listeners = new Set<(frame: Frame) => void>()
  readonly #frames: Frame[] = []
  #ordinal = 0

  constructor(readonly epoch: string) {}

  /** Live subscriptions currently registered. */
  get subscribers() {
    return this.#listeners.size
  }

  push(seq: number, data: string): Frame {
    const frame: Frame = { id: formatID(this.epoch, seq), seq, data, ordinal: ++this.#ordinal }
    this.#frames.push(frame)
    for (const listener of this.#listeners) listener(frame)
    return frame
  }

  /**
   * Subscribe, optionally resuming after `cursor`. The live listener is
   * registered BEFORE the buffer is read, and live frames already covered by
   * the replay are dropped, so nothing published around the reconnect is
   * missed or delivered twice.
   */
  subscribe(cursor?: string | null): Subscription {
    let deliver: ((frame: Frame) => void) | undefined
    let pending: Frame[] = []
    const listener = (frame: Frame) => (deliver ? deliver(frame) : pending.push(frame))
    this.#listeners.add(listener)

    const watermark = this.#ordinal
    const parsed = parseCursor(cursor)
    const resume = parsed && parsed.epoch === this.epoch ? parsed.seq : undefined
    const replay = resume === undefined ? [] : this.#frames.filter((frame) => frame.seq > resume)

    return {
      position: resume ?? GlobalBus.seq,
      replay,
      start: (fn) => {
        const queued = pending
        pending = []
        for (const frame of queued) if (frame.ordinal > watermark) fn(frame)
        deliver = fn
      },
      close: () => {
        this.#listeners.delete(listener)
        pending = []
      },
    }
  }
}

export const GlobalEventReplay = new ReplayBuffer(GlobalBus.epoch)

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
  GlobalEventReplay.push(seq, data)
})
