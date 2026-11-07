// #1777 — the client's resume cursor for the global event stream, and the
// contiguity check that makes every unreplayable loss loud. A ZERO-DEPENDENCY
// pure module (like stream-liveness.ts — no solid-js, no @opencode-ai/*) so its
// test runs in place; server-sdk.tsx's stream loop feeds it each data frame's
// SSE id and payload type, and acts on the verdict.
//
// The wire (#1776, #1511): an engine stamps every global-stream frame
// `id: <epoch>:<seq>`. Bus events take strictly increasing seqs; the
// per-connection control frames (`server.connected`, `server.heartbeat`, the
// `server.cursor.unservable` reset) consume none and carry the CURRENT seq — so
// a heartbeat exposes a hole even on an idle stream. A fleet-of-one fan-in
// passes the engine's ids through untouched; a fanned-in stream's id is the
// composite `local=<id>;<peer>=<id>` of every origin's position, and each frame
// moves only its own origin's.
//
// The CURSOR is that SSE id — never the JSON payload id the client tracked
// before, which the engine rejects as malformed (every reconnect was a reset).
// Contiguity is checked per origin, per epoch:
//   - the next bus event of an origin must be seq + 1; anything later is a HOLE
//     (a resync of that origin is owed), anything at or behind it a DUPLICATE
//     (a replayed frame already applied — dropped, never applied twice);
//   - a control frame may sit at the position; past it is a hole;
//   - a new epoch nothing announced is a hole (an engine restart the relay
//     chain lost); a reset, or a gap the relay announced, re-bases the origin.
import { resolveEventOrigin } from "./sse-origin"

/** The reserved namespace of the always-present local source (#1511 §D4). */
export const LOCAL_ORIGIN = "local"

const CONTROL_TYPES = new Set(["server.connected", "server.heartbeat", "server.cursor.unservable"])
const RESET_TYPE = "server.cursor.unservable"

type Position = { epoch: string; seq: number }

function enginePosition(value: string | undefined): Position | undefined {
  if (value === undefined) return undefined
  const m = /^([A-Za-z0-9_-]+):(\d+)$/.exec(value)
  return m ? { epoch: m[1], seq: Number(m[2]) } : undefined
}

/** A stream id as per-origin positions: the composite `<ns>=<id>;…`, or a bare
 *  id (no `=`, the fleet-of-one / direct-engine form) as the local origin's. */
export function originPositions(id: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  const trimmed = id?.trim()
  if (!trimmed) return out
  if (!trimmed.includes("=")) {
    out.set(LOCAL_ORIGIN, trimmed)
    return out
  }
  for (const entry of trimmed.split(";")) {
    const eq = entry.indexOf("=")
    if (eq <= 0) continue
    out.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  return out
}

export type StreamResync = { reason: "hole" | "reset"; namespaces: string[] }

/** What the stream loop does with one data frame. */
export type StreamCursorVerdict = {
  /** false: a duplicate of a frame already applied — drop it. */
  apply: boolean
  /** The origin that sent it: a peer's machine id, or undefined for local. */
  origin: string | undefined
  /** Present when frames of these origins were lost: resync them. */
  resync?: StreamResync
}

export function createStreamCursor(initial?: string) {
  let raw = initial?.trim() || undefined
  let applied = originPositions(raw)
  // origins whose next position is a new baseline (after an announced gap)
  const rebase = new Set<string>()

  const frame = (input: { id: string | undefined; type: string | undefined }): StreamCursorVerdict => {
    const id = input.id?.trim()
    if (!id) return { apply: true, origin: undefined } // no SSE id (an older engine): nothing to check
    const next = originPositions(id)
    const bare = !id.includes("=")
    const control = input.type !== undefined && CONTROL_TYPES.has(input.type)
    const reset = input.type === RESET_TYPE
    const changed = [...next.keys()].filter((ns) => next.get(ns) !== applied.get(ns))
    // #1539: the origin is the namespace the composite moved (fleet-of-one: local)
    const origin = resolveEventOrigin(id, Object.fromEntries(applied)).origin

    const holes: string[] = []
    let behind = false
    for (const ns of changed) {
      const prev = enginePosition(applied.get(ns))
      const cur = enginePosition(next.get(ns))
      if (reset || rebase.has(ns) || prev === undefined || cur === undefined) continue // a baseline
      if (cur.epoch !== prev.epoch) {
        holes.push(ns)
        continue
      }
      if (cur.seq <= prev.seq) {
        behind = true
        continue
      }
      if (cur.seq > prev.seq + (control ? 0 : 1)) holes.push(ns)
    }

    // A frame behind what was applied: a replayed bus event is a duplicate
    // (dropped); a control frame (a connection resumed from an older cursor)
    // still applies, but never moves the cursor back.
    if (behind) return control ? { apply: true, origin } : { apply: false, origin }
    // Fleet-of-one: the last bus event again (same engine id) is a duplicate.
    if (changed.length === 0 && bare && !control && enginePosition(id)) return { apply: false, origin }

    raw = id
    if (bare) applied = next
    else for (const [ns, value] of next) applied.set(ns, value)
    for (const ns of changed) rebase.delete(ns)

    if (reset) return { apply: true, origin, resync: { reason: "reset", namespaces: changed.length > 0 ? changed : [...next.keys()] } }
    if (holes.length > 0) return { apply: true, origin, resync: { reason: "hole", namespaces: holes } }
    return { apply: true, origin }
  }

  return {
    /** The cursor to resume from: the last applied frame's SSE id, verbatim. */
    current: (): string | undefined => raw,
    frame,
    /** The relay announced a gap for these origins (none named = every origin);
     *  the loop resyncs them, so their next positions are new baselines. */
    gap(namespaces: string[]): void {
      for (const ns of namespaces.length > 0 ? namespaces : [...applied.keys()]) rebase.add(ns)
    },
    /** Forget the cursor: the next connection opens without one. */
    clear(): void {
      raw = undefined
      applied = new Map()
      rebase.clear()
    },
  }
}

export type StreamCursor = ReturnType<typeof createStreamCursor>

const STREAM_PATHS = new Set(["/event", "/global/event"])

const withoutLastEventIdHeader = (init: RequestInit | undefined): RequestInit | undefined => {
  if (!init?.headers) return init
  const headers = new Headers(init.headers)
  headers.delete("last-event-id")
  return { ...init, headers }
}

/** The ONE cursor carrier on the event stream request: `?lastEventID=<cursor>`
 *  — the parameter the fan-in, the proxies and the engine all read. The SDK
 *  reader would add its own `Last-Event-ID` header on an internal retry, which
 *  the engine prefers; it is removed, so two cursors can never disagree. No
 *  cursor: none is sent. Any other request passes through untouched. */
export function applyStreamCursor(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  base: string,
  cursor: string | undefined,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
  let url: URL
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, base)
  } catch {
    return { input, init }
  }
  if (!STREAM_PATHS.has(url.pathname)) return { input, init }
  if (cursor) url.searchParams.set("lastEventID", cursor)
  else url.searchParams.delete("lastEventID")
  if (typeof input === "string") return { input: url.toString(), init: withoutLastEventIdHeader(init) }
  if (input instanceof URL) return { input: url, init: withoutLastEventIdHeader(init) }
  const request = new Request(url.toString(), input)
  request.headers.delete("last-event-id")
  return { input: request, init: withoutLastEventIdHeader(init) }
}
