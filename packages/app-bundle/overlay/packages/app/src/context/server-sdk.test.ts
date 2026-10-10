import { afterEach, describe, expect, test, vi } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  adaptServerEvent,
  applySseError,
  coalesceServerEvents,
  createDeadMansSwitch,
  DEAD_MAN_MISSES,
  deadManThresholdMs,
  enqueueServerEvent,
  HEARTBEAT_CADENCE_MS,
  isStreamClosed,
  resumeStreamAfterPageShow,
} from "./server-sdk"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts the stream on pageshow regardless of persisted flag", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(2)
  })

  test("is safe to call repeatedly (start is idempotent)", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)

    expect(starts).toBe(3)
  })
})

describe("applySseError", () => {
  const spy = () => {
    const calls = { disconnect: 0, abort: 0 }
    return {
      calls,
      disconnect: () => calls.disconnect++,
      abort: () => calls.abort++,
    }
  }

  test("a real stream failure ABORTS the attempt, not just marks it disconnected", () => {
    // The regression: the v1 stream's iterator never throws or completes on
    // failure, so the reconnect loop only comes round if the attempt is
    // aborted. Marking disconnected without aborting leaves the client dead on
    // a server that is already back.
    const s = spy()
    expect(applySseError({ closed: false, ...s })).toBe(true)
    expect(s.calls).toEqual({ disconnect: 1, abort: 1 })
  })

  test("an already-closed stream is left alone — that is our own abort coming back", () => {
    const s = spy()
    expect(applySseError({ closed: true, ...s })).toBe(false)
    expect(s.calls).toEqual({ disconnect: 0, abort: 0 })
  })

  test("repeated failures keep aborting — recovery must not depend on a first-error latch", () => {
    const s = spy()
    applySseError({ closed: false, ...s })
    applySseError({ closed: false, ...s })
    expect(s.calls.abort).toBe(2)
  })
})

describe("dead-man's switch (#1751) — the stream reader's own liveness clock", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("a stream that goes silent while nominally open fires the switch at the threshold, once", () => {
    // The 17:22:50 frontdoor death: connection open, zero frames, zero
    // reconnects for 12 minutes. The switch must notice the silence itself.
    vi.useFakeTimers()
    let dead = 0
    const deadMan = createDeadMansSwitch(() => {
      dead += 1
    })
    deadMan.open()

    vi.advanceTimersByTime(44_999)
    expect(dead).toBe(0)

    vi.advanceTimersByTime(1)
    expect(dead).toBe(1)

    // One abort per silent window, not a recurring alarm — the reconnect
    // loop owns the gap once the dead stream has been torn down.
    vi.advanceTimersByTime(60_000)
    expect(dead).toBe(1)
  })

  test("a healthy stream is NEVER aborted — frames within the threshold keep re-arming", () => {
    // Invisibility to a healthy stream is the invariant: no behavior change
    // while frames flow, only silence may fire the switch.
    vi.useFakeTimers()
    let dead = 0
    const deadMan = createDeadMansSwitch(() => {
      dead += 1
    })
    deadMan.open()

    // Heartbeats every cadence (15s < 45s threshold), for a long while.
    for (let beat = 0; beat < 40; beat += 1) {
      vi.advanceTimersByTime(15_000)
      deadMan.frame()
    }
    expect(dead).toBe(0)

    // Deltas faster than the heartbeat are just more liveness.
    for (let beat = 0; beat < 100; beat += 1) {
      vi.advanceTimersByTime(1_000)
      deadMan.frame()
    }
    expect(dead).toBe(0)
  })

  test("close() disarms the switch — a clean close never fires it (regression pin)", () => {
    // The clean-close path reconnects on its own (the loop goes round when
    // the iterator ends); the switch must stay invisible to it. This pins
    // that disarm: no frame needed, no abort requested.
    vi.useFakeTimers()
    let dead = 0
    const deadMan = createDeadMansSwitch(() => {
      dead += 1
    })

    deadMan.open()
    vi.advanceTimersByTime(44_000)
    deadMan.close()
    vi.advanceTimersByTime(120_000)
    expect(dead).toBe(0)

    // Re-arming after the reconnect works: the next attempt starts a fresh
    // silent window.
    deadMan.open()
    vi.advanceTimersByTime(44_999)
    expect(dead).toBe(0)
    vi.advanceTimersByTime(1)
    expect(dead).toBe(1)
  })

  test("the threshold is configurable — the switch honors a custom window", () => {
    vi.useFakeTimers()
    let dead = 0
    const deadMan = createDeadMansSwitch(() => {
      dead += 1
    }, 5_000)
    deadMan.open()

    vi.advanceTimersByTime(4_999)
    expect(dead).toBe(0)

    vi.advanceTimersByTime(1)
    expect(dead).toBe(1)
  })
})

describe("dead-man threshold seam (#1751)", () => {
  test("derives from the heartbeat cadence it documents: 3 × 15s = 45s", () => {
    expect(HEARTBEAT_CADENCE_MS).toBe(15_000)
    expect(DEAD_MAN_MISSES).toBe(3)
    expect(deadManThresholdMs({})).toBe(HEARTBEAT_CADENCE_MS * DEAD_MAN_MISSES)
  })

  test("AMICODE_SSE_DEADMAN_MS overrides the threshold", () => {
    expect(deadManThresholdMs({ AMICODE_SSE_DEADMAN_MS: "12000" })).toBe(12_000)
  })

  test("an unusable override degrades to the derived default — never disables the switch", () => {
    expect(deadManThresholdMs({ AMICODE_SSE_DEADMAN_MS: "not-a-number" })).toBe(45_000)
    expect(deadManThresholdMs({ AMICODE_SSE_DEADMAN_MS: "0" })).toBe(45_000)
    expect(deadManThresholdMs({ AMICODE_SSE_DEADMAN_MS: "-5" })).toBe(45_000)
  })

  test("the abrupt-death scenario: silence aborts the parked reader, and the abort reads as a closed stream", async () => {
    // The 17:22:50 repro as a unit scenario. The stream is nominally open and
    // delivering; the host dies with no clean close — the reader sits parked
    // inside next(). The fetch-stream contract (the one applySseError's abort
    // relies on) is that aborting the attempt's signal is what makes that
    // parked promise reject. The switch must notice the silence itself and
    // convert the death into exactly the kind of stream end the reconnect
    // loop already knows how to go round on — a closed one.
    vi.useFakeTimers()
    const attempt = new AbortController()
    let parkedResolve: ((result: { value: { type: string }; done: boolean }) => void) | undefined
    let parkedReject: ((error: unknown) => void) | undefined
    attempt.signal.addEventListener("abort", () => {
      parkedResolve = undefined
      parkedReject?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
    })
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise((resolve, reject) => {
              parkedResolve = resolve
              parkedReject = reject
            }),
        }
      },
    }
    // one healthy heartbeat arrives at t=10s, then the host dies: silence.
    setTimeout(() => {
      const resolve = parkedResolve
      parkedResolve = undefined
      resolve?.({ value: { type: "server.heartbeat" }, done: false })
    }, 10_000)

    const status: string[] = []
    // the reader loop's liveness wiring, verbatim: arm on connect, frame per
    // frame, disconnect + abort when the switch fires, disarm on teardown.
    const deadMan = createDeadMansSwitch(() => {
      status.push("disconnected")
      attempt.abort()
    })
    const seen: string[] = []
    const read = (async () => {
      try {
        deadMan.open()
        for await (const frame of stream as AsyncIterable<{ type: string }>) {
          deadMan.frame()
          seen.push(frame.type)
        }
        return "done"
      } catch (error) {
        return error
      } finally {
        deadMan.close()
      }
    })()
    const settle = async (turns = 30) => {
      for (let i = 0; i < turns; i += 1) await Promise.resolve()
    }
    await settle()

    vi.advanceTimersByTime(10_000)
    await settle()
    expect(seen).toEqual(["server.heartbeat"])

    // silence past the re-armed deadline: healthy at 44.999s past the frame…
    vi.advanceTimersByTime(44_999)
    expect(status).toEqual([])
    // …dead at the full threshold.
    vi.advanceTimersByTime(1)
    await settle()
    const result = await read

    expect(status).toEqual(["disconnected"])
    expect(seen).toEqual(["server.heartbeat"])
    expect((result as Error).name).toBe("AbortError")
    // the loop's catch classifier reads our own abort as a closed stream:
    // silent reconnect, no error latch — the while-condition is untouched,
    // so the loop goes round and reopens with the lastEventID cursor.
    expect(isStreamClosed(result, attempt.signal)).toBe(true)
  })
})

describe("dead-man wiring in the reader loop (#1751)", () => {
  // SOURCE assertions (the submit-stream-gap #1203 precedent): the reader
  // loop in createServerSdkContextBase pulls platform/protocol context with
  // no provider harness in this package. The switch's behavior is pinned
  // above; this pins where it rides — the connection owns its own liveness.

  const source = readFileSync(join(import.meta.dir, "server-sdk.tsx"), "utf8")

  test("the switch rides the reader — armed once the stream is nominally open", () => {
    const connected = source.indexOf('setStreamStatus("connected")')
    const open = source.indexOf("deadMan.open()")
    expect(connected).toBeGreaterThan(-1)
    expect(open).toBeGreaterThan(connected)
  })

  test("every frame re-arms it — before any continue fast-path in the for-await", () => {
    const forAwait = source.indexOf("for await (const event of events)")
    const frame = source.indexOf("deadMan.frame()")
    const fastPath = source.indexOf("continue", forAwait)
    expect(forAwait).toBeGreaterThan(-1)
    expect(frame).toBeGreaterThan(forAwait)
    expect(frame).toBeLessThan(fastPath)
  })

  test("teardown disarms it before the attempt is released", () => {
    const close = source.indexOf("deadMan.close()")
    const release = source.indexOf("attempt = undefined", close)
    expect(close).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(close)
  })

  test("a fired switch marks the stream disconnected and aborts the attempt", () => {
    const onDead = source.indexOf("createDeadMansSwitch(() => {")
    expect(onDead).toBeGreaterThan(-1)
    const body = source.slice(onDead, onDead + 200)
    expect(body).toContain('setStreamStatus("disconnected")')
    expect(body).toContain("attempt?.abort()")
  })
})

describe("adaptServerEvent", () => {
  test("preserves V2 events while adapting permission requests for existing consumers", () => {
    const current = {
      id: "evt_1",
      created: 1,
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "read", resources: ["src/**"] },
    } as OpenCodeEvent

    expect(adaptServerEvent(current)).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm_1", sessionID: "ses_1", permission: "read", patterns: ["src/**"] },
      current,
    })
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("merges adjacent current text deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", ordinal: 0, delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
