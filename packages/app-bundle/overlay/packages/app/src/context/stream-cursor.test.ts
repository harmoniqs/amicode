import { describe, expect, test } from "bun:test"
import { applyStreamCursor, createStreamCursor } from "./stream-cursor"

// #1777 — the client's resume cursor and its contiguity check, extracted as a
// ZERO-DEPENDENCY pure module (like stream-liveness.ts) so it runs in place.
// server-sdk.tsx's global stream loop feeds it every data frame's SSE `id:` (the
// SDK reader's `onSseEvent`) and its payload type, and acts on the verdict.
//
// Wire facts (#1776, #1511): an engine stamps every global-stream frame
// `id: <epoch>:<seq>` — bus events take strictly increasing seqs, and the
// per-connection control frames (server.connected / server.heartbeat /
// server.cursor.unservable) carry the CURRENT seq without consuming one. A
// fleet-of-one fan-in passes those ids through untouched; a fanned-in stream's
// id is the composite `local=<id>;<peer>=<id>` of every origin's position.

const E = "bG9jYWwx" // the local engine's epoch
const P = "c3R1ZGlv" // a peer engine's epoch
const id = (epoch: string, seq: number) => `${epoch}:${seq}`
const composite = (local: number, studio: number) => `local=${id(E, local)};studio=${id(P, studio)}`
const event = (frameId: string | undefined, type = "message.part.updated") => ({ id: frameId, type })

describe("#1777 AC4 — the cursor is the SSE id, and it survives a reconnect and a reload", () => {
  test("fleet-of-one: the cursor is the engine's bare id, verbatim", () => {
    const cursor = createStreamCursor()
    expect(cursor.current()).toBeUndefined()
    cursor.frame(event(id(E, 0), "server.connected"))
    cursor.frame(event(id(E, 1)))
    expect(cursor.current()).toBe(id(E, 1))
  })

  test("fanned in: the cursor is the composite id, verbatim", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(composite(1, 7)))
    cursor.frame(event(composite(2, 7)))
    expect(cursor.current()).toBe(composite(2, 7))
  })

  test("never the JSON payload id: a frame without an SSE id leaves the cursor where it was", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 4)))
    expect(cursor.frame(event(undefined))).toEqual({ apply: true, origin: undefined })
    expect(cursor.current()).toBe(id(E, 4))
  })

  test("after a reload: the stored cursor is resumed from, and frames are checked against it", () => {
    const cursor = createStreamCursor(id(E, 9))
    expect(cursor.current()).toBe(id(E, 9))
    expect(cursor.frame(event(id(E, 9), "server.connected")).resync).toBeUndefined() // the engine resumed at it
    expect(cursor.frame(event(id(E, 11))).resync).toEqual({ reason: "hole", namespaces: ["local"] }) // 10 never came
  })

  test("the ONE carrier: `?lastEventID=` on the global stream, and never a conflicting Last-Event-ID header", () => {
    const base = "http://127.0.0.1:4096"
    const req = new Request(`${base}/global/event`, { headers: { "Last-Event-ID": "stale:1", authorization: "Basic x" } })
    const out = applyStreamCursor(req, undefined, base, composite(3, 8))
    const sent = out.input as Request
    expect(new URL(sent.url).searchParams.get("lastEventID")).toBe(composite(3, 8))
    expect(sent.headers.get("last-event-id")).toBeNull()
    expect(sent.headers.get("authorization")).toBe("Basic x")

    // a string input, a stale header in init: the same single carrier
    const str = applyStreamCursor(`${base}/global/event?lastEventID=old`, { headers: { "Last-Event-ID": "old" } }, base, id(E, 2))
    expect(new URL(str.input as string).searchParams.get("lastEventID")).toBe(id(E, 2))
    expect(new Headers(str.init?.headers).get("last-event-id")).toBeNull()

    // no cursor (a fresh or reset stream): no cursor at all
    const fresh = applyStreamCursor(`${base}/global/event?lastEventID=old`, undefined, base, undefined)
    expect(new URL(fresh.input as string).searchParams.has("lastEventID")).toBe(false)

    // any other request is untouched
    const other = `${base}/session`
    expect(applyStreamCursor(other, undefined, base, id(E, 2)).input).toBe(other)
  })
})

describe("#1777 AC4 — a sequence hole within one origin triggers a resync of that origin", () => {
  test("fleet-of-one: a bus event that skips a seq is a hole — applied, and a resync is owed", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 1)))
    expect(cursor.frame(event(id(E, 3)))).toEqual({ apply: true, origin: undefined, resync: { reason: "hole", namespaces: ["local"] } })
    expect(cursor.frame(event(id(E, 4))).resync).toBeUndefined() // contiguous again
  })

  test("an idle stream: a heartbeat carrying a seq the client never saw is a hole", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 5)))
    expect(cursor.frame(event(id(E, 5), "server.heartbeat")).resync).toBeUndefined() // at the position: fine
    expect(cursor.frame(event(id(E, 6), "server.heartbeat")).resync).toEqual({ reason: "hole", namespaces: ["local"] })
  })

  test("fanned in: contiguity is per origin — a hole in the peer's seq resyncs the peer, the local arm's frames never count against it", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(composite(5, 42)))
    expect(cursor.frame(event(composite(6, 42))).resync).toBeUndefined() // local advanced by one
    expect(cursor.frame(event(composite(7, 42))).resync).toBeUndefined()
    expect(cursor.frame(event(composite(7, 43)))).toEqual({ apply: true, origin: "studio" }) // the peer, contiguous
    expect(cursor.frame(event(composite(7, 45)))).toEqual({ apply: true, origin: "studio", resync: { reason: "hole", namespaces: ["studio"] } })
  })

  test("per epoch: an engine restart nothing announced is a resync, and the new epoch is the new baseline", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 30)))
    expect(cursor.frame(event(id("bG9jYWwy", 1))).resync).toEqual({ reason: "hole", namespaces: ["local"] })
    expect(cursor.frame(event(id("bG9jYWwy", 2))).resync).toBeUndefined()
  })

  test("a first sighting is a baseline, and ids that are not an engine's (an older relay) are never checked", () => {
    const cursor = createStreamCursor()
    expect(cursor.frame(event(id(E, 50))).resync).toBeUndefined()
    const relay = createStreamCursor()
    relay.frame(event("17"))
    expect(relay.frame(event("40"))).toEqual({ apply: true, origin: undefined })
  })
})

describe("#1777 AC2 — an upstream reset forces exactly one full resync", () => {
  test("fleet-of-one: the engine's reset frame is a resync of `local`, and its new position is the baseline", () => {
    const cursor = createStreamCursor(id(E, 12)) // a cursor from before the engine restarted
    const reset = cursor.frame(event(id("bG9jYWwy", 3), "server.cursor.unservable"))
    expect(reset).toEqual({ apply: true, origin: undefined, resync: { reason: "reset", namespaces: ["local"] } })
    expect(cursor.current()).toBe(id("bG9jYWwy", 3))
    expect(cursor.frame(event(id("bG9jYWwy", 3), "server.connected")).resync).toBeUndefined()
    expect(cursor.frame(event(id("bG9jYWwy", 4))).resync).toBeUndefined()
  })

  test("a reset BEHIND the client's cursor (the engine's `ahead` reason, same epoch) is still the new baseline", () => {
    const cursor = createStreamCursor(id(E, 40)) // a cursor past what the engine has
    expect(cursor.frame(event(id(E, 7), "server.cursor.unservable")).resync).toEqual({ reason: "reset", namespaces: ["local"] })
    expect(cursor.current()).toBe(id(E, 7))
    expect(cursor.frame(event(id(E, 8)))).toEqual({ apply: true, origin: undefined }) // not mistaken for a duplicate
  })

  test("fanned in: after a gap names the peer, its next position (a new epoch) is a new baseline — one resync, not two", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(composite(5, 42)))
    cursor.gap(["studio"]) // the fan-in turned the peer's reset into a gap; the loop resyncs on it
    const next = `local=${id(E, 5)};studio=${id("c3R1ZGlvMg", 7)}`
    expect(cursor.frame(event(next, "server.connected"))).toEqual({ apply: true, origin: "studio" })
    expect(cursor.frame(event(`local=${id(E, 5)};studio=${id("c3R1ZGlvMg", 8)}`)).resync).toBeUndefined()
  })

  test("a gap naming no namespace re-bases every origin", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(composite(5, 42)))
    cursor.gap([])
    expect(cursor.frame(event(composite(9, 42))).resync).toBeUndefined()
    expect(cursor.frame(event(composite(9, 50))).resync).toBeUndefined()
    expect(cursor.frame(event(composite(9, 52))).resync).toEqual({ reason: "hole", namespaces: ["studio"] }) // checked again
  })

  test("clear() forgets the cursor (an attachment change opens the stream cursorless)", () => {
    const cursor = createStreamCursor(id(E, 3))
    cursor.clear()
    expect(cursor.current()).toBeUndefined()
    expect(cursor.frame(event(id("bG9jYWwy", 90))).resync).toBeUndefined()
  })
})

describe("#1777 AC5 — replayed frames are never applied twice", () => {
  test("fleet-of-one: a bus event at or behind the applied seq is dropped; the cursor never moves back", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 5)))
    expect(cursor.frame(event(id(E, 5))).apply).toBe(false) // the last frame again
    expect(cursor.frame(event(id(E, 3))).apply).toBe(false) // an older one
    expect(cursor.current()).toBe(id(E, 5))
    expect(cursor.frame(event(id(E, 6)))).toEqual({ apply: true, origin: undefined })
  })

  test("fanned in: a peer frame behind the peer's applied seq is dropped", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(composite(5, 42)))
    expect(cursor.frame(event(composite(5, 41))).apply).toBe(false)
    expect(cursor.current()).toBe(composite(5, 42))
    expect(cursor.frame(event(composite(5, 43))).apply).toBe(true)
  })

  test("a connection resumed from an older cursor: its handshake still applies, but the replay of what was applied is dropped", () => {
    const cursor = createStreamCursor()
    for (const s of [1, 2, 3]) cursor.frame(event(id(E, s)))
    expect(cursor.frame(event(id(E, 1), "server.connected")).apply).toBe(true) // control: delivered, cursor kept
    expect(cursor.current()).toBe(id(E, 3))
    expect(cursor.frame(event(id(E, 2))).apply).toBe(false)
    expect(cursor.frame(event(id(E, 3))).apply).toBe(false)
    expect(cursor.frame(event(id(E, 4)))).toEqual({ apply: true, origin: undefined })
  })

  test("the control frames at the position are never mistaken for duplicates", () => {
    const cursor = createStreamCursor()
    cursor.frame(event(id(E, 5)))
    for (const type of ["server.connected", "server.heartbeat"]) expect(cursor.frame(event(id(E, 5), type)).apply).toBe(true)
  })
})
