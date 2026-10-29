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

const LF = 10;
const CR = 13;

/** A per-CONNECTION SSE filter: buffers upstream bytes, splits them into whole
 *  event blocks, DROPS blocks whose seq is at or below the resume threshold
 *  (the boundary dedupe), forwards the rest VERBATIM, and reports each
 *  forwarded seq so the store's high-water mark advances. Byte-preserving —
 *  kept blocks are re-emitted exactly as received (steady-state unchanged).
 *
 *  #1790: LINEAR-TIME scanning — scans only the new chunk, carrying a
 *  two-byte lookback for a frame boundary (`\n\n` or `\r\n\r\n`) split
 *  across chunks.  Replaces the quadratic `boundaryEnd(this.buf)` loop which
 *  re-scanned the whole accumulated partial buffer on every incoming chunk. */
export class SessionStreamFilter {
  /** The partial frame, as received (accumulated until a boundary is found). */
  private parts: Buffer[] = [];
  /** The last ≤2 bytes of the partial frame — lookback for a split delimiter. */
  private tail: Buffer = Buffer.alloc(0);

  constructor(
    private readonly resumeFrom: number | undefined,
    private readonly onForward: (seq: number) => void,
  ) {}

  /** Feed raw upstream bytes; returns the bytes to forward to the client. */
  push(chunk: Buffer | string): Buffer {
    const c: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (c.length === 0) return Buffer.alloc(0);
    const out: Buffer[] = [];
    const tail = this.tail;
    let start = 0; // where the current partial frame resumes in this chunk
    let floor = -tail.length; // the current frame's first position (negative = in the tail)
    /** The byte at chunk position `i` (negative reaches into the tail), or NaN
     *  before the current frame — a lookback never crosses a frame boundary
     *  (same rule as SseFrameSplitter). Without it, the LF that ends one frame
     *  would make a lone `\n` right after it look like a blank line. */
    const at = (i: number): number => (i < floor ? NaN : i >= 0 ? c[i] : tail[tail.length + i]);

    // A frame ends at a line feed whose line is empty: the byte before it is a
    // line feed (`\n\n`, `\r\n\n`), or a CR preceded by a line feed
    // (`\r\n\r\n`, `\n\r\n`).
    let lf: number;
    let from = 0;
    while ((lf = c.indexOf(LF, from)) !== -1) {
      from = lf + 1;
      const prev = at(lf - 1);
      if (prev !== LF && !(prev === CR && at(lf - 2) === LF)) continue;
      this.parts.push(c.subarray(start, from));
      const frame = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [];
      start = floor = from;

      // a whole frame: any multibyte character in it arrived whole, so decoding is safe
      const seq = blockSeq(frame.toString("utf8"));
      // dedupe: a durable event already delivered (seq <= the resume cursor) is
      // dropped — idempotent resume, no double-delivery at the boundary.
      if (seq !== undefined && this.resumeFrom !== undefined && seq <= this.resumeFrom) continue;
      if (seq !== undefined) this.onForward(seq);
      out.push(frame);
    }

    if (start < c.length) {
      const rest = start === 0 ? c : c.subarray(start);
      this.parts.push(rest);
      // the last ≤2 bytes of the partial frame — only reach back into the old
      // tail when no frame ended in this chunk (the tail belongs to this frame)
      this.tail = rest.length >= 2 ? rest.subarray(-2) : start === 0 ? Buffer.concat([tail, rest]).subarray(-2) : rest;
    } else {
      this.tail = Buffer.alloc(0); // a frame ended exactly at the chunk's end
    }

    return out.length === 0 ? Buffer.alloc(0) : out.length === 1 ? out[0] : Buffer.concat(out);
  }

  /** Flush any trailing partial block on stream end (never lose bytes). */
  flush(): Buffer {
    if (this.parts.length === 0) return Buffer.alloc(0);
    const rest = Buffer.concat(this.parts);
    this.parts = [];
    this.tail = Buffer.alloc(0);
    return rest;
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
