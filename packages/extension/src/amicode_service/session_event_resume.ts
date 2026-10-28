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

    // Scan for `\n` (LF) bytes in the new chunk only.  A blank SSE line
    // immediately follows another line ending, so:
    //   `\n\n`       — LF at i, prev byte (i-1 in chunk, or from tail) is also LF.
    //   `\r\n\r\n`   — LF at i, prev is CR, and the byte before that is LF.
    //   `\n\r\n`     — LF at i, prev is CR, byte before that is LF (mixed endings).
    //   `\r\n\n`     — LF at i, prev is LF (coming right after a CRLF-terminated line).
    //   `\r\n`-only blank line: after a CR, the next LF makes it \r\n\r\n or \n\r\n.
    // All patterns reduce to: the LF at `i` ends an empty line, meaning the
    // byte before the line ending is itself a line-feed (LF) — or, with CRLF,
    // the two bytes before are CR+LF.  Same logic as SseFrameSplitter.
    const LF = 10, CR = 13;
    const at = (i: number): number => {
      // i < 0 → look into tail; i >= 0 → look into chunk; i < start → past frame boundary
      if (i < -tail.length) return NaN;
      if (i < 0) return tail[tail.length + i];
      return c[i];
    };

    for (let i = start; i < c.length; i++) {
      if (c[i] !== LF) continue;
      // Is the line this LF ends empty?
      const prev = at(i - 1);
      if (prev !== LF && !(prev === CR && at(i - 2) === LF)) continue;
      // Found a frame boundary at position i (inclusive — the frame ends at i+1).
      const frameEnd = i + 1;
      this.parts.push(c.subarray(start, frameEnd));
      const frame = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [];
      start = frameEnd;
      this.tail = Buffer.alloc(0);

      // seq extraction: decode the frame as UTF-8 text (any multibyte chars at
      // boundaries arrive here whole, so toString is safe at this point).
      const seq = blockSeq(frame.toString("utf8"));
      // dedupe: a durable event already delivered (seq <= the resume cursor) is
      // dropped — idempotent resume, no double-delivery at the boundary.
      if (seq !== undefined && this.resumeFrom !== undefined && seq <= this.resumeFrom) continue;
      if (seq !== undefined) this.onForward(seq);
      out.push(frame);
    }

    if (start < c.length) {
      const rest = c.subarray(start);
      this.parts.push(rest);
      // keep the last ≤2 bytes as the lookback for the next chunk's scan
      this.tail = rest.length >= 2 ? rest.subarray(-2) : Buffer.concat([tail, rest]).subarray(-2);
    }

    return out.length === 0 ? Buffer.alloc(0) : (out.length === 1 ? out[0] : Buffer.concat(out));
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
