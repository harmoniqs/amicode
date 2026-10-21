// The global event stream's replay buffer (#1776, ported onto the lane for
// #1806 P1a). One tap on the global bus serializes each event once, at emit,
// into a frame stamped with its `<epoch>:<seq>` id; the buffer keeps recent
// frames (one buffer shared by every subscriber, bounded by bytes and age) and
// fans each frame out to the live subscriptions. A connection that resumes
// from a servable cursor gets the frames after it, then live frames; any other
// cursor gets an explicit reset.
//
// Lane adaptations vs main (#1806):
//  - a frame keeps a reference to the emitted event (`event`): this engine
//    serves TWO wire shapes off the one buffer (the global route serializes
//    `data` verbatim; the instance /event route projects the payload view from
//    the live object), so subscribers never re-parse the wire serialization;
//  - a cursor that is not `<epoch>:<seq>` resolves against retained frames by
//    payload id instead of resetting outright: the lane's client tracks
//    payload ids (#1264), and wire compatibility requires its cursors to keep
//    being served — resolved when the retained history covers them, reset as
//    evicted when it does not;
//  - #1814 P3 ports main's patch-body wire cut (#1778's wireEvent, 06eac851):
//    the serialized frame and the instance route's payload view both strip
//    summary-diff patch bodies (`wirePayload` below), while the `event` the
//    buffer keeps — what in-process subscribers and storage see — is whole.
import { GlobalBus, type GlobalEvent } from "./global"

export type Frame = {
  /** The SSE id: `<epoch>:<seq>`. */
  readonly id: string
  readonly seq: number
  /** The serialized global event — the SSE `data`. */
  readonly data: string
  /** The emitted event itself — the buffer's in-process view (see header). */
  readonly event: GlobalEvent
  /** UTF-8 size of `data`, charged against the byte bound. */
  readonly bytes: number
  /** Push time (ms), checked against the age bound. */
  readonly time: number
  /** Push order; unlike `seq` it is unique per frame (a sync copy shares its source's seq). */
  readonly ordinal: number
  /**
   * A sync copy sharing the sequence of the frame it mirrors (#1778). Sent only
   * to subscribers that request sync copies; dropping it leaves no hole in a
   * subscriber's sequence, because its source carries the same one.
   */
  readonly syncCopy: boolean
}

export type Bounds = {
  /** Retained frame bytes; the oldest frames are evicted past it. */
  readonly maxBytes: number
  /** Retained frame age in milliseconds; older frames are evicted. */
  readonly maxAgeMs: number
}

/** About 32 MB and 5 minutes of history: covers link blips and window reloads. */
export const DEFAULT_BOUNDS: Bounds = { maxBytes: 32 * 1024 * 1024, maxAgeMs: 5 * 60_000 }

export const BOUNDS_ENV = {
  maxBytes: "OPENCODE_GLOBAL_EVENT_REPLAY_MAX_BYTES",
  maxAgeMs: "OPENCODE_GLOBAL_EVENT_REPLAY_MAX_AGE_MS",
} as const

/** The buffer bounds from the environment; an unset or invalid value keeps its default. */
export function boundsFromEnv(env: Record<string, string | undefined>): Bounds {
  const read = (key: string, fallback: number) => {
    const raw = env[key]?.trim()
    if (!raw || !/^\d+$/.test(raw)) return fallback
    return Number(raw)
  }
  return {
    maxBytes: read(BOUNDS_ENV.maxBytes, DEFAULT_BOUNDS.maxBytes),
    maxAgeMs: read(BOUNDS_ENV.maxAgeMs, DEFAULT_BOUNDS.maxAgeMs),
  }
}

export function formatID(epoch: string, seq: number) {
  return `${epoch}:${seq}`
}

/** Parse an `<epoch>:<seq>` cursor; `undefined` when malformed. */
export function parseCursor(raw: string): { epoch: string; seq: number } | undefined {
  const match = /^([A-Za-z0-9_-]+):(\d+)$/.exec(raw.trim())
  if (!match) return undefined
  return { epoch: match[1], seq: Number(match[2]) }
}

/** Why a cursor cannot be served. */
export type ResetReason = "malformed" | "epoch" | "ahead" | "evicted"

export type Subscription = {
  /** The connection's starting position: the sequence its first frame follows. */
  readonly position: number
  /** Set when the cursor could not be served: the connection must start with a reset frame. */
  readonly reset: ResetReason | undefined
  /** Frames after the cursor, in order — delivered before any live frame. */
  readonly replay: readonly Frame[]
  /** Begin delivering live frames (any that arrived since subscribing first, minus duplicates of `replay`). */
  start(deliver: (frame: Frame) => void): void
  /** Unregister. Idempotent. */
  close(): void
}

export class ReplayBuffer {
  readonly #listeners = new Set<(frame: Frame) => void>()
  // Retained frames are #frames[#head..]; evicted slots before #head are
  // compacted away in batches so eviction stays O(1) amortized.
  #frames: (Frame | undefined)[] = []
  #head = 0
  #bytes = 0
  #ordinal = 0
  #current: number
  // The highest sequence whose frames are no longer all retained (evicted, or
  // emitted before this buffer existed). A cursor below it cannot be served.
  #floor: number

  readonly epoch: string
  readonly bounds: Bounds
  readonly #now: () => number

  constructor(input: {
    epoch: string
    bounds?: Bounds
    /** The sequence the buffer starts at (events before it were never recorded). */
    start?: number
    now?: () => number
  }) {
    this.epoch = input.epoch
    this.bounds = input.bounds ?? DEFAULT_BOUNDS
    this.#now = input.now ?? Date.now
    this.#current = input.start ?? 0
    this.#floor = this.#current
  }

  /** The current sequence: the last one pushed (or skipped). */
  get current() {
    return this.#current
  }

  /** Live subscriptions currently registered. */
  get subscribers() {
    return this.#listeners.size
  }

  push(seq: number, event: GlobalEvent, data: string, options: { syncCopy?: boolean } = {}): Frame {
    const frame: Frame = {
      id: formatID(this.epoch, seq),
      seq,
      data,
      event,
      bytes: Buffer.byteLength(data),
      time: this.#now(),
      ordinal: ++this.#ordinal,
      syncCopy: options.syncCopy === true,
    }
    this.#current = Math.max(this.#current, seq)
    this.#frames.push(frame)
    this.#bytes += frame.bytes
    for (const listener of this.#listeners) listener(frame)
    this.#evict()
    return frame
  }

  /** Advance past a sequence that produced no frame (the hole stays visible to clients). */
  skip(seq: number) {
    this.#current = Math.max(this.#current, seq)
  }

  /**
   * Subscribe, optionally resuming after `cursor`. The live listener is
   * registered BEFORE the buffer is read, and live frames already covered by
   * the replay are dropped, so nothing published around the reconnect is
   * missed or delivered twice. Sync copies reach the subscription only when it
   * asks for them (`sync`), in its replay and its live frames alike.
   */
  subscribe(cursor?: string, options: { sync?: boolean } = {}): Subscription {
    const wanted = options.sync === true ? () => true : (frame: Frame) => !frame.syncCopy
    let deliver: ((frame: Frame) => void) | undefined
    let pending: Frame[] = []
    const listener = (frame: Frame) => {
      if (!wanted(frame)) return
      if (deliver) deliver(frame)
      else pending.push(frame)
    }
    this.#listeners.add(listener)

    this.#evict()
    const watermark = this.#ordinal
    const resolved = this.#resolve(cursor)
    const replay = resolved.reset
      ? []
      : this.#retained().filter((frame) => frame.seq > resolved.position && wanted(frame))

    return {
      ...resolved,
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

  #resolve(cursor: string | undefined): { position: number; reset: ResetReason | undefined } {
    if (cursor === undefined) return { position: this.#current, reset: undefined }
    const parsed = parseCursor(cursor)
    if (parsed) {
      const reset: ResetReason | undefined =
        parsed.epoch !== this.epoch
          ? "epoch"
          : parsed.seq > this.#current
            ? "ahead"
            : parsed.seq < this.#floor
              ? "evicted"
              : undefined
      return reset ? { position: this.#current, reset } : { position: parsed.seq, reset: undefined }
    }
    // Legacy vocabulary (the lane's client sends the last payload id it
    // applied, #1264): resolve to the newest retained frame at or behind the
    // cursor and serve the frames after it; a cursor no retained frame covers
    // predates retention and resets.
    let resolved: Frame | undefined
    for (const frame of this.#retained()) {
      const id = frame.event.payload?.id
      if (typeof id === "string" && id <= cursor) resolved = frame
    }
    if (resolved) return { position: resolved.seq, reset: undefined }
    return { position: this.#current, reset: "evicted" }
  }

  #retained(): Frame[] {
    return this.#frames.slice(this.#head) as Frame[]
  }

  // Oldest-first, until retained bytes and the oldest frame's age are both within bounds.
  #evict() {
    const oldest = this.#now() - this.bounds.maxAgeMs
    while (this.#head < this.#frames.length) {
      const frame = this.#frames[this.#head]!
      if (this.#bytes <= this.bounds.maxBytes && frame.time >= oldest) break
      this.#frames[this.#head++] = undefined
      this.#bytes -= frame.bytes
      this.#floor = Math.max(this.#floor, frame.seq)
    }
    if (this.#head > 1024 && this.#head * 2 > this.#frames.length) {
      this.#frames = this.#frames.slice(this.#head)
      this.#head = 0
    }
  }
}

export const GlobalEventReplay = new ReplayBuffer({
  epoch: GlobalBus.epoch,
  bounds: boundsFromEnv(process.env),
  start: GlobalBus.seq,
})

/**
 * The wire form of an event payload (#1778, #1814 P3). A per-turn summary
 * (`info.summary.diffs` of a message or session) carries the full patch text
 * of every changed file — measured up to 12.3 MB in one event. On the wire each
 * diff keeps its file, status and counts and drops its patch body; the surfaces
 * that render a patch fetch the stored message on demand. Only the wire forms
 * change: the event object (what in-process subscribers and storage see) is
 * never mutated, and a sync copy is sent whole — its subscriber replays it into
 * a store of its own, which must keep the full record.
 */
export function wirePayload<T extends { type?: string; properties?: any }>(payload: T): T {
  if (!payload || typeof payload !== "object" || payload.type === "sync") return payload
  const info = payload.properties?.info
  const diffs = info?.summary?.diffs
  if (!Array.isArray(diffs) || !diffs.some((diff) => diff && typeof diff === "object" && "patch" in diff)) return payload
  return {
    ...payload,
    properties: {
      ...payload.properties,
      info: {
        ...info,
        summary: {
          ...info.summary,
          diffs: diffs.map((diff) => {
            if (!diff || typeof diff !== "object" || !("patch" in diff)) return diff
            const { patch: _patch, ...rest } = diff
            return rest
          }),
        },
      },
    },
  }
}

/** The wire form of a global event: `wirePayload` over its payload. */
export function wireEvent(event: GlobalEvent): GlobalEvent {
  const payload = event.payload
  if (!payload || typeof payload !== "object" || payload.type === "sync") return event
  const next = wirePayload(payload)
  return next === payload ? event : { ...event, payload: next }
}

GlobalBus.tap((event, seq) => {
  // A sync copy whose sequence was already handed out mirrors its source. One
  // that consumed a fresh sequence (no source framed nearby) is a frame of its
  // own and reaches every subscriber, so filtering never opens a hole.
  const syncCopy = event.payload?.type === "sync" && seq <= GlobalEventReplay.current
  let data: string
  try {
    // serialized once: every subscriber, live or replayed, gets this same frame
    data = JSON.stringify(wireEvent(event))
  } catch (error) {
    // An unserializable event cannot be framed; its sequence becomes a hole the
    // client detects (heartbeats carry the current sequence), never a dead stream.
    console.error("global event not serializable", { seq, type: event.payload?.type, error })
    GlobalEventReplay.skip(seq)
    return
  }
  GlobalEventReplay.push(seq, event, data, { syncCopy })
})
