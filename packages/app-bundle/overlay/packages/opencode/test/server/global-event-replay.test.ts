// #1776 (ported, #1806 P1a) — the global stream's shared replay buffer: one
// buffer per bus bounded by bytes and age (env-tunable, main's defaults),
// oldest-first eviction, cursor resolution, and the reset contract. The lane
// addition: a cursor that is not `<epoch>:<seq>` (the lane's client tracks
// payload ids) resolves against retained frames — it is served when the
// history covers it and reset when it does not.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_BOUNDS, ReplayBuffer, boundsFromEnv, formatID, parseCursor } from "../../src/bus/global-replay"

const frameOf = (bytes: number) => "x".repeat(bytes)
const eventOf = (type: string, id?: string) => ({
  directory: "/tmp/p1a-replay",
  payload: id === undefined ? { type, properties: {} } : { id, type, properties: {} },
})

function buffer(bounds: { maxBytes: number; maxAgeMs: number }, clock = { now: 0 }, epoch = "ep0ch") {
  return new ReplayBuffer({ epoch, bounds, now: () => clock.now })
}

const seqs = (b: ReplayBuffer, cursor: string) => {
  const sub = b.subscribe(cursor)
  sub.close()
  return sub.reset ?? sub.replay.map((frame) => frame.seq)
}

describe("global event replay buffer — bounds (#1776 port)", () => {
  test("evicts oldest-first once retained bytes exceed the byte bound", () => {
    const b = buffer({ maxBytes: 30, maxAgeMs: 60_000 })
    for (const seq of [1, 2, 3]) b.push(seq, eventOf("test.a"), frameOf(10))
    expect(seqs(b, "ep0ch:0")).toEqual([1, 2, 3])

    b.push(4, eventOf("test.a"), frameOf(10)) // 40 bytes > 30: the oldest frame goes
    expect(seqs(b, "ep0ch:0")).toBe("evicted")
    expect(seqs(b, "ep0ch:1")).toEqual([2, 3, 4])

    b.push(5, eventOf("test.a"), frameOf(25)) // 55 bytes: evict 2, 3, 4 (oldest first) until within bound
    expect(seqs(b, "ep0ch:3")).toBe("evicted")
    expect(seqs(b, "ep0ch:4")).toEqual([5])
  })

  test("evicts oldest-first once frames are older than the age bound", () => {
    const clock = { now: 0 }
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 1_500 }, clock)
    b.push(1, eventOf("test.a"), frameOf(10))
    clock.now = 1_000
    b.push(2, eventOf("test.a"), frameOf(10))
    clock.now = 1_400
    expect(seqs(b, "ep0ch:0")).toEqual([1, 2])

    clock.now = 2_000 // frame 1 is 2000 ms old (> 1500), frame 2 is 1000 ms old
    expect(seqs(b, "ep0ch:0")).toBe("evicted")
    expect(seqs(b, "ep0ch:1")).toEqual([2])

    clock.now = 3_000 // both aged out; a cursor at the current sequence is still servable
    b.push(3, eventOf("test.a"), frameOf(10))
    expect(seqs(b, "ep0ch:1")).toBe("evicted")
    expect(seqs(b, "ep0ch:2")).toEqual([3])
    expect(seqs(b, "ep0ch:3")).toEqual([])
  })

  test("both bounds are read from the environment, defaulting to 32 MiB and 5 minutes", () => {
    expect(DEFAULT_BOUNDS).toEqual({ maxBytes: 32 * 1024 * 1024, maxAgeMs: 5 * 60_000 })
    expect(
      boundsFromEnv({
        OPENCODE_GLOBAL_EVENT_REPLAY_MAX_BYTES: "1024",
        OPENCODE_GLOBAL_EVENT_REPLAY_MAX_AGE_MS: "60000",
      }),
    ).toEqual({ maxBytes: 1024, maxAgeMs: 60_000 })
    expect(boundsFromEnv({})).toEqual(DEFAULT_BOUNDS)
    expect(
      boundsFromEnv({ OPENCODE_GLOBAL_EVENT_REPLAY_MAX_BYTES: "lots", OPENCODE_GLOBAL_EVENT_REPLAY_MAX_AGE_MS: "-5" }),
    ).toEqual(DEFAULT_BOUNDS)
  })

  test("the engine's shared buffer takes its bounds from the process environment", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'const { GlobalEventReplay } = await import("./src/bus/global-replay.ts"); console.log(JSON.stringify(GlobalEventReplay.bounds))',
      ],
      cwd: path.join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        OPENCODE_GLOBAL_EVENT_REPLAY_MAX_BYTES: "4096",
        OPENCODE_GLOBAL_EVENT_REPLAY_MAX_AGE_MS: "2500",
      },
    })
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString())).toEqual({ maxBytes: 4096, maxAgeMs: 2500 })
  })
})

describe("global event replay buffer — the reset contract (#1776 port)", () => {
  test("a cursor from a foreign epoch resets (an engine restart is a resync boundary)", () => {
    const a = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 }, { now: 0 }, "ep0ch")
    a.push(1, eventOf("test.a"), frameOf(10))
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 }, { now: 0 }, "other")
    const sub = b.subscribe(formatID("ep0ch", 1))
    expect(sub.reset).toBe("epoch")
    sub.close()
  })

  test("a cursor ahead of the stream resets, and one at the current sequence serves live", () => {
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 })
    b.push(1, eventOf("test.a"), frameOf(10))
    const ahead = b.subscribe("ep0ch:5")
    expect(ahead.reset).toBe("ahead")
    ahead.close()
    const atCurrent = b.subscribe("ep0ch:1")
    expect(atCurrent.reset).toBeUndefined()
    expect(atCurrent.position).toBe(1)
    atCurrent.close()
  })

  test("a garbage cursor below retained history resets; one above it resolves live-only", () => {
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 })
    b.push(1, eventOf("test.a", "evt_p1a_malformed_1"), frameOf(10))
    // Below every retained payload id: nothing covers it — the reset contract.
    const below = b.subscribe("aaa")
    expect(below.reset).toBe("evicted")
    below.close()
    // Above every retained payload id: the legacy vocabulary is order-based,
    // and a cursor newer than every retained frame is live-only — the old
    // ring's exact semantics (a heartbeat cursor behaves the same way).
    const above = b.subscribe("not-a-cursor")
    expect(above.reset).toBeUndefined()
    expect(above.position).toBe(1)
    expect(above.replay).toEqual([])
    above.close()
  })

  test("formatID/parseCursor round-trip and reject malformed ids", () => {
    expect(formatID("ep0ch", 7)).toBe("ep0ch:7")
    expect(parseCursor(" ep0ch:7 ")).toEqual({ epoch: "ep0ch", seq: 7 })
    expect(parseCursor("evt_131b06142001C9nKEJ5DvEnx4G")).toBeUndefined()
    expect(parseCursor("a:b")).toBeUndefined()
    expect(parseCursor("ep0ch:1:2")).toBeUndefined()
  })
})

describe("global event replay buffer — legacy payload-id cursors (the lane's wire compat)", () => {
  test("a payload-id cursor resolves to the last retained frame at or behind it and serves the frames after", () => {
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 })
    b.push(1, eventOf("test.a", "evt_p1a_leg_1"), frameOf(10))
    b.push(2, eventOf("test.b", "evt_p1a_leg_2"), frameOf(10))
    b.push(3, eventOf("test.c", "evt_p1a_leg_3"), frameOf(10))
    const sub = b.subscribe("evt_p1a_leg_2")
    expect(sub.reset).toBeUndefined()
    expect(sub.position).toBe(2)
    expect(sub.replay.map((frame) => frame.seq)).toEqual([3])
    sub.close()
  })

  test("a payload-id cursor newer than every retained frame resolves live-only (a heartbeat cursor)", () => {
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 })
    b.push(1, eventOf("test.a", "evt_p1a_leg_1"), frameOf(10))
    const sub = b.subscribe("evt_p1a_leg_9")
    expect(sub.reset).toBeUndefined()
    expect(sub.position).toBe(1)
    expect(sub.replay).toEqual([])
    sub.close()
  })

  test("a payload-id cursor older than every retained frame resets as evicted", () => {
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 60_000 })
    b.push(1, eventOf("test.a", "evt_p1a_leg_1"), frameOf(10))
    const sub = b.subscribe("evt_0".padEnd(35, "0"))
    expect(sub.reset).toBe("evicted")
    sub.close()
  })
})
