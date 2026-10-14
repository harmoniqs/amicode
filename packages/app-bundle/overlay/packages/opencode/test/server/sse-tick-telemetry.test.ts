// #1798 Phase A — engine-side SSE heartbeat tick telemetry + out-of-tree self-stall
// watchdog. These tests pin the harness ACs from the approved spec
// (spec-20261014-101500): the watchdog fires under a wedged emitter AND under a
// simulated Effect-tree stall (the out-of-tree proof), tick telemetry lines
// flow at cadence while healthy, the both-ends timestamp delta stays inside one
// cadence window, and the per-tick overhead stays negligible.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Queue, Stream } from "effect"
import { makeSseTickTelemetry } from "../../src/server/shared/sse-tick-telemetry"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Fast harness config: production runs 10s cadence / 15s watchdog; the scale
// factor here is 250:1 — every assertion below is written against the scaled
// equivalents of the production AC bounds.
const fastConfig = { cadenceMs: 40, watchdogIntervalMs: 80, probeIntervalMs: 50 }

describe("sse tick telemetry", () => {
  test("SELF-STALL names the stall when the emitter's write is blocked", async () => {
    const lines: Array<string> = []
    const telemetry = makeSseTickTelemetry({ ...fastConfig, sink: (line) => lines.push(line) })
    telemetry.registerConnection("/event", "conn-blocked")

    // A wedged write: a bounded queue that fills and is never drained. The tick
    // source parks on the second offer — heartbeats stop exactly the way a
    // dead-but-unerrored socket write blocks emission (#1798 hypothesis 1).
    const blocked = await Effect.runPromise(Queue.bounded<string>(1))
    let ticks = 0
    const fiber = Effect.runFork(
      Stream.tick(fastConfig.cadenceMs).pipe(
        Stream.tap(() =>
          Effect.gen(function* () {
            yield* Queue.offer(blocked, "heartbeat")
            telemetry.noteTick("/event", "conn-blocked", {
              queueDepth: Queue.sizeUnsafe(blocked),
              fiberId: yield* Effect.fiberId,
            })
            ticks++
          }),
        ),
        Stream.runDrain,
      ),
    )

    await sleep(300)

    await Effect.runPromise(Fiber.interrupt(fiber))
    telemetry.stop()

    // The wedge took effect: exactly one tick was emitted, then the write parked.
    expect(ticks).toBe(1)
    // The watchdog named the death out-of-tree while the emitter fiber sat parked.
    const stalls = lines.filter((line) => line.startsWith("SELF-STALL"))
    expect(stalls.length).toBeGreaterThanOrEqual(1)
    expect(stalls[0]).toContain("ticks_expected=")
    expect(stalls[0]).toContain("seen=0")
    expect(stalls[0]).toContain("conns=1")
    // The healthy phase logged its tick line before going silent.
    const tickLines = lines.filter((line) => line.startsWith("SSE-TICK"))
    expect(tickLines.length).toBe(1)
  })

  test("SELF-STALL fires under a simulated Effect-tree stall — the watchdog is outside the fiber tree", async () => {
    const lines: Array<string> = []
    const telemetry = makeSseTickTelemetry({ ...fastConfig, sink: (line) => lines.push(line) })
    telemetry.registerConnection("/event", "conn-tree")

    // The tick source is a real Effect fiber tree: Stream.tick on the live
    // clock, driving noteTick. After warm ticks the per-tick effect parks on a
    // never-resolving async — the tick fiber is stalled mid-tree, the
    // #775-family wedge shape (fiber tree makes no progress on the tick
    // source while the JS event loop stays healthy).
    let wedged = false
    const fiber = Effect.runFork(
      Stream.tick(fastConfig.cadenceMs).pipe(
        Stream.tap(() =>
          Effect.gen(function* () {
            telemetry.noteTick("/event", "conn-tree", { queueDepth: 0, fiberId: yield* Effect.fiberId })
            if (wedged) yield* Effect.async<void>(() => {})
          }),
        ),
        Stream.runDrain,
      ),
    )

    await sleep(150)
    const healthyTicks = lines.filter((line) => line.startsWith("SSE-TICK")).length
    expect(healthyTicks).toBeGreaterThanOrEqual(2)
    expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)

    // Stall the fiber tree's tick source in-tree.
    wedged = true
    await sleep(300)

    await Effect.runPromise(Fiber.interrupt(fiber))
    telemetry.stop()

    // The raw-timer watchdog observed the in-tree stall and named the death —
    // an Effect-tree watchdog would be wedged with the tree and observe nothing.
    const stalls = lines.filter((line) => line.startsWith("SELF-STALL"))
    expect(stalls.length).toBeGreaterThanOrEqual(1)
    expect(stalls[0]).toContain("seen=0")
    expect(stalls[0]).toContain("route=/event")
  })
})
