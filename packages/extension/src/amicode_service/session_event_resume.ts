// SESSION EVENT RESUME (#1264, Slice 4): lossless SSE reconnect for the
// PER-SESSION event stream, tracked entirely on the CLIENT (relay) side.
//
// The engine's `/api/session/{sessionID}/event?after=<seq>` route is resumable
// ("Replay durable events after an aggregate sequence, then continue with new
// durable events") — each event carries an aggregate `seq` as its SSE `id:`.
// This module makes the relay carry that seq across tunnel blips: it records
// the last seq DELIVERED to the client per session, injects `?after=<seq>` when
// the client reconnects that session's stream, and dedupes the boundary so the
// resume is idempotent (a replay that re-includes already-delivered seqs never
// double-delivers).
//
// SCOPE (issue #1264): the PER-SESSION stream ONLY. The multiplexed `/event`
// (per-instance) and `/global/event` streams have NO cursor form — the engine
// emits `id: undefined` on them and `/global/event` rides an in-memory bus with
// nothing to replay. They are OUT of scope here and are LEFT AS-IS: `plan()`
// returns undefined for any non per-session-event path, so those streams pipe
// through the relay byte-for-byte unchanged (never given an `?after=`, never
// deduped). Making them resumable is separate engine work (emit SSE ids + a
// durable/vector-cursor live stream); see ADR 0024 and #775.

/** Match a per-session event-stream path, returning its sessionID.
 *  ONLY `/api/session/{id}/event` — deliberately NOT `/event` or
 *  `/global/event` (the non-resumable multiplexed streams, out of scope). */
export function matchSessionEventPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/api\/session\/([^/]+)\/event$/);
  return m ? m[1] : undefined;
}

/** Find the end offset of the first SSE event boundary (a blank line) in `s`,
 *  or -1 if none is complete yet. Handles both LF (`\n\n`) and CRLF
 *  (`\r\n\r\n`) framings. Returns the index JUST PAST the delimiter so the
 *  block is forwarded verbatim (delimiter included). */
function boundaryEnd(s: string): number {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return -1;
  if (crlf < 0 || (lf >= 0 && lf < crlf)) return lf + 2;
  return crlf + 4;
}

/** The aggregate seq of an SSE event block = its LAST `id:` line (SSE
 *  last-wins), parsed as a number. Undefined for a block with no numeric id
 *  (a comment/heartbeat, or an id-less event) — such blocks are never deduped. */
function blockSeq(block: string): number | undefined {
  let seq: number | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) {
      const v = Number(line.slice(3).trim());
      if (Number.isFinite(v)) seq = v;
    }
  }
  return seq;
}

/** A per-CONNECTION SSE filter: buffers upstream bytes, splits them into whole
 *  event blocks, DROPS blocks whose seq is at or below the resume threshold
 *  (the boundary dedupe), forwards the rest VERBATIM, and reports each
 *  forwarded seq so the store's high-water mark advances. Byte-preserving —
 *  kept blocks are re-emitted exactly as received (steady-state unchanged). */
export class SessionStreamFilter {
  private buf = "";
  constructor(
    private readonly resumeFrom: number | undefined,
    private readonly onForward: (seq: number) => void,
  ) {}

  /** Feed raw upstream bytes; returns the bytes to forward to the client. */
  push(chunk: Buffer | string): Buffer {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out: string[] = [];
    let end: number;
    while ((end = boundaryEnd(this.buf)) >= 0) {
      const block = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const seq = blockSeq(block);
      // dedupe: a durable event already delivered (seq <= the resume cursor) is
      // dropped — idempotent resume, no double-delivery at the boundary.
      if (seq !== undefined && this.resumeFrom !== undefined && seq <= this.resumeFrom) continue;
      if (seq !== undefined) this.onForward(seq);
      out.push(block);
    }
    return Buffer.from(out.join(""), "utf8");
  }

  /** Flush any trailing partial block on stream end (never lose bytes). */
  flush(): Buffer {
    const rest = this.buf;
    this.buf = "";
    return Buffer.from(rest, "utf8");
  }
}

/** The relay's resume plan for one proxied request. */
export interface SessionResumePlan {
  sessionID: string;
  /** The `?after=` value to inject on the UPSTREAM request, or undefined to
   *  leave the request's `after` as-is (no cursor yet, or the caller already
   *  supplied one). */
  afterToInject?: string;
  /** The per-connection dedupe/track filter for this stream's body. */
  filter: SessionStreamFilter;
}

/** Per-session cursor store for the relay's lifetime. One aggregate `seq`
 *  high-water mark per session (per aggregate — never one global cursor), so
 *  each session resumes independently. */
export class SessionEventResume {
  private readonly delivered = new Map<string, number>();

  /** The last seq delivered to the client for a session, or undefined. */
  cursor(sessionID: string): number | undefined {
    return this.delivered.get(sessionID);
  }

  /** Reset EVERY session's cursor — a SWITCH (#1344, ADR 0027 §3/D4: the
   *  attachment pointer flips to a different server) invalidates every tracked
   *  seq at once (a different server's aggregate seqs are meaningless), so the
   *  next per-session subscription to the newly-attached server opens a FRESH
   *  stream with NO `?after=`. Idempotent: resetting an empty store is a no-op. */
  reset(): void {
    this.delivered.clear();
  }

  private record(sessionID: string, seq: number): void {
    const prev = this.delivered.get(sessionID);
    if (prev === undefined || seq > prev) this.delivered.set(sessionID, seq);
  }

  /** Plan the resume for one incoming request URL. Returns undefined for any
   *  path that is NOT a per-session event stream (so `/event`, `/global/event`,
   *  and every other proxied route are left untouched — AC3). */
  plan(url: URL): SessionResumePlan | undefined {
    const sessionID = matchSessionEventPath(url.pathname);
    if (sessionID === undefined) return undefined;
    const explicitRaw = url.searchParams.get("after");
    const explicit = explicitRaw !== null && Number.isFinite(Number(explicitRaw)) ? Number(explicitRaw) : undefined;
    const cursor = this.delivered.get(sessionID);
    // Inject the tracked cursor ONLY when the caller supplied no `after` of its
    // own — a client that manages its own cursor is deferred to, not overridden.
    const afterToInject = explicitRaw === null && cursor !== undefined ? String(cursor) : undefined;
    // Dedupe threshold: an explicit `after` wins (respect the caller's intent);
    // otherwise our tracked high-water mark.
    const resumeFrom = explicit ?? cursor;
    const filter = new SessionStreamFilter(resumeFrom, (seq) => this.record(sessionID, seq));
    return { sessionID, ...(afterToInject !== undefined ? { afterToInject } : {}), filter };
  }
}
