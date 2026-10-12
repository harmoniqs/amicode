// #1776 — the global stream's replay buffer: one shared buffer bounded by
// bytes and age, evicting oldest-first, both bounds configurable by environment.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_BOUNDS, ReplayBuffer, boundsFromEnv } from "../../src/bus/global-replay"

const frameOf = (bytes: number) => "x".repeat(bytes)

function buffer(bounds: { maxBytes: number; maxAgeMs: number }, clock = { now: 0 }) {
  return new ReplayBuffer({ epoch: "ep0ch", bounds, now: () => clock.now })
}

const seqs = (b: ReplayBuffer, cursor: string) => {
  const sub = b.subscribe(cursor)
  sub.close()
  return sub.reset ?? sub.replay.map((frame) => frame.seq)
}

describe("global event replay buffer — bounds (#1776)", () => {
  test("evicts oldest-first once retained bytes exceed the byte bound", () => {
    const b = buffer({ maxBytes: 30, maxAgeMs: 60_000 })
    for (const seq of [1, 2, 3]) b.push(seq, frameOf(10))
    expect(seqs(b, "ep0ch:0")).toEqual([1, 2, 3])

    b.push(4, frameOf(10)) // 40 bytes > 30: the oldest frame goes
    expect(seqs(b, "ep0ch:0")).toBe("evicted")
    expect(seqs(b, "ep0ch:1")).toEqual([2, 3, 4])

    b.push(5, frameOf(25)) // 55 bytes: evict 2, 3, 4 (oldest first) until within bound
    expect(seqs(b, "ep0ch:3")).toBe("evicted")
    expect(seqs(b, "ep0ch:4")).toEqual([5])
  })

  test("evicts oldest-first once frames are older than the age bound", () => {
    const clock = { now: 0 }
    const b = buffer({ maxBytes: 1 << 20, maxAgeMs: 1_500 }, clock)
    b.push(1, frameOf(10))
    clock.now = 1_000
    b.push(2, frameOf(10))
    clock.now = 1_400
    expect(seqs(b, "ep0ch:0")).toEqual([1, 2])

    clock.now = 2_000 // frame 1 is 2000 ms old (> 1500), frame 2 is 1000 ms old
    expect(seqs(b, "ep0ch:0")).toBe("evicted")
    expect(seqs(b, "ep0ch:1")).toEqual([2])

    clock.now = 3_000 // both aged out; a cursor at the current sequence is still servable
    b.push(3, frameOf(10))
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
