// linear_sse_frame_splitting_1790.test.ts — #1790: linear-time SSE frame
// splitting in the three remaining stream readers.
//
// The relay's upstream reader and the app's global-stream reader were fixed in
// #1779.  Three readers were left behind:
//   1. OpencodeEventClient.onChunk (sse_client.ts) — appends chunk to `this.buf`
//      and calls `this.buf.indexOf("\n\n")` from the start on every chunk.
//   2. SessionMultiplexProxy.openSseStream (session_multiplexer.ts) — same
//      `buf += chunk; buf.indexOf("\n\n")` pattern in the peer event-stream reader.
//   3. SessionStreamFilter.push (session_event_resume.ts) — uses `boundaryEnd()`
//      which also calls `s.indexOf("\n\n")` and `s.indexOf("\r\n\r\n")` on the
//      full accumulated partial buffer.
//
// All three miss the `\r\n\r\n` SSE frame boundary too (only detect `\n\n`).
//
// AC1 — each reader splits a 10 MB frame in 64 KB chunks within 3× of the time
//        for the same frame delivered as one chunk.
// AC2 — each reader ends a frame at a CRLF blank line, including a boundary that
//        straddles two chunks.
// AC3 — framing otherwise unchanged: multi-line data, event names, ids, retry —
//        byte-identical, with the input cut at every byte offset.

import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import * as http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { SessionStreamFilter } from "../src/amicode_service/session_event_resume";
import {
  SessionOwnerMap,
  SessionMultiplexProxy,
  sessionEventChunkReader,
} from "../src/amicode_service/session_multiplexer";
import { OpencodeEventClient, type OpencodeStreamEvent } from "../src/sse_client";
import {
  largeSummaryFrame,
  chunkBytes,
  CHUNK_64K,
  TEN_MB,
  LOCAL_EPOCH,
} from "./fixtures/engine_stream/engine_frames";

// ── timing helpers ────────────────────────────────────────────────────────────

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const elapsedMs = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

/** Warm up then interleaved trials, take medians. */
function splitTimeRatio(
  read: (chunks: Buffer[]) => unknown,
  whole: Buffer[],
  chunked: Buffer[],
): { ratio: number; wholeMs: number; chunkedMs: number } {
  for (let i = 0; i < 2; i++) { read(whole); read(chunked); }
  const one: number[] = [];
  const many: number[] = [];
  for (let i = 0; i < 7; i++) {
    one.push(elapsedMs(() => read(whole)));
    many.push(elapsedMs(() => read(chunked)));
  }
  const wholeMs = median(one);
  const chunkedMs = median(many);
  return { ratio: chunkedMs / wholeMs, wholeMs, chunkedMs };
}
const SPLIT_RATIO_FACTOR = 3;

/** Every way to cut `text`'s bytes into two pieces, plus byte-at-a-time. */
function everySplit(text: string): Buffer[][] {
  const all = Buffer.from(text, "utf8");
  const out: Buffer[][] = [];
  for (let k = 1; k < all.length; k++) out.push([all.subarray(0, k), all.subarray(k)]);
  out.push(Array.from({ length: all.length }, (_, i) => all.subarray(i, i + 1)));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader 1 helper: SessionStreamFilter (session_event_resume.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Feed chunks through a filter; return the output bytes and forwarded seqs. */
function runFilter(chunks: Buffer[], resumeFrom?: number): { output: string; seqs: number[] } {
  const seqs: number[] = [];
  const filter = new SessionStreamFilter(resumeFrom, (seq) => seqs.push(seq));
  const parts: Buffer[] = [];
  for (const c of chunks) parts.push(filter.push(c));
  parts.push(filter.flush());
  return { output: Buffer.concat(parts).toString("utf8"), seqs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader 2 helper: OpencodeEventClient (sse_client.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Drive the client with a real local http server; collect dispatched events. */
function runClient(chunks: Buffer[]): Promise<OpencodeStreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: OpencodeStreamEvent[] = [];
    const lines: string[] = [];
    const channel = { appendLine: (l: string) => lines.push(l) } as never;

    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders?.();
      let i = 0;
      const writeNext = () => {
        if (i >= chunks.length) { res.end(); return; }
        res.write(chunks[i++]);
        setImmediate(writeNext);
      };
      writeNext();
    });

    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const client = new OpencodeEventClient({ channel, onEvent: (e) => events.push(e) });
      client.connect(new URL(`http://127.0.0.1:${port}`));

      const poll = setInterval(() => {
        if (lines.some((l) => l.includes("stream ended") || l.includes("req error") || l.includes("bad status"))) {
          clearInterval(poll);
          client.dispose();
          srv.close(() => resolve(events));
        }
      }, 10);
      setTimeout(() => {
        clearInterval(poll);
        client.dispose();
        srv.close(() => reject(new Error("timeout")));
      }, 5_000);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reader 3 helper: SessionMultiplexProxy.openSseStream (session_multiplexer.ts)
//
// The proxy opens `/api/session/{id}/event` against the owner peer, reads it
// with the same `buf += chunk; buf.indexOf("\n\n")` quadratic pattern, and
// returns events via next().  The stream handle has no "end" signal — the
// `next()` Promise hangs after the server closes.  We test via a callback-based
// approach: hook the `onEvent` handler of a thin wrapper that calls `next()`
// repeatedly until the stream stops delivering within a timeout.
// ─────────────────────────────────────────────────────────────────────────────

/** Drive the mux stream reader via the real http server.
 *  Collects events until no new one arrives for `idleMs` after the server ends. */
function runMuxStream(
  chunks: Buffer[],
  { idleMs = 200 }: { idleMs?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders?.();
      let i = 0;
      const writeNext = () => {
        if (i >= chunks.length) { res.end(); return; }
        res.write(chunks[i++]);
        setImmediate(writeNext);
      };
      writeNext();
    });

    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as import("node:net").AddressInfo;
      const ownerMap = new SessionOwnerMap();
      ownerMap.update([
        { id: "ses_large", amicode_owner: { owner_machine_id: "peer", owner_name: "peer", is_local: false } },
      ]);
      const proxy = new SessionMultiplexProxy({
        ownerMap,
        localMachineId: "macbook",
        peers: { peer: { getUrl: () => `http://127.0.0.1:${port}` } },
      });
      const handle = proxy.openSseStream("ses_large");
      const collected: Array<Record<string, unknown>> = [];

      // Pull events; after `idleMs` with no new event, stop.
      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          handle.close();
          srv.close(() => resolve(collected));
        }, idleMs);
      };

      const globalTimeout = setTimeout(() => {
        clearTimeout(idleTimer);
        handle.close();
        srv.close(() => reject(new Error("runMuxStream: global timeout")));
      }, 8_000);

      const pull = (): void => {
        handle.next().then((ev) => {
          clearTimeout(globalTimeout);
          const rec = ev as Record<string, unknown>;
          if (!rec._closed) {
            collected.push(rec);
            resetIdle();
            pull();
          } else {
            clearTimeout(idleTimer);
            clearTimeout(globalTimeout);
            srv.close(() => resolve(collected));
          }
        }).catch(() => {
          clearTimeout(idleTimer);
          clearTimeout(globalTimeout);
          srv.close(() => resolve(collected));
        });
      };

      resetIdle();
      pull();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — timing: each reader within 3× of one-chunk baseline
// ─────────────────────────────────────────────────────────────────────────────

describe("#1790 AC1 — SessionStreamFilter: 10 MB frame in 64 KB chunks ≤ 3× one-chunk time", () => {
  it("chunked ÷ whole ≤ 3, and both deliveries pass the frame byte-identical", () => {
    // Build a single valid SSE frame ≥10 MB.  largeSummaryFrame() already ends
    // in \n\n; add an id: line in front (the filter tracks it as a seq).
    const inner = largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 1 });
    // inner = "id: bG9jYWwx:1\ndata: {...}\n\n"
    // We wrap it as-is (it already IS a valid SSE frame).
    const stream = inner;
    expect(Buffer.byteLength(stream)).toBeGreaterThanOrEqual(TEN_MB);

    const whole = [Buffer.from(stream, "utf8")];
    const chunked = chunkBytes(stream, CHUNK_64K);
    expect(chunked.length).toBeGreaterThan(160);

    // Both must yield the same byte-identical output.
    const wholeOut = runFilter(whole).output;
    const chunkOut = runFilter(chunked).output;
    expect(wholeOut).toBe(stream);
    expect(chunkOut).toBe(stream);

    const read = (cs: Buffer[]) => runFilter(cs);
    const { ratio, wholeMs, chunkedMs } = splitTimeRatio(read, whole, chunked);
    if (process.env.SPLIT_RATIO_LOG) {
      appendFileSync(process.env.SPLIT_RATIO_LOG, `session_event_resume ${ratio.toFixed(3)} ${wholeMs.toFixed(2)} ${chunkedMs.toFixed(2)}\n`);
    }
    expect(ratio, `chunked ${chunkedMs.toFixed(1)} ms vs whole ${wholeMs.toFixed(1)} ms`).toBeLessThanOrEqual(SPLIT_RATIO_FACTOR);
  }, 60_000);
});

describe("#1790 AC1 — OpencodeEventClient: 10 MB frame in 64 KB chunks ≤ 3× one-chunk time", () => {
  // Times the client's real per-chunk path — OpencodeEventClient.onChunk
  // (liveness note, frame split, block parse, dispatch) — fed the decoded
  // chunks the socket would deliver. Only the socket itself is left out; the
  // AC2/AC3 suites below drive the same path through a real server.
  it("onChunk: chunked ÷ whole ≤ 3, and the frame is dispatched once either way", () => {
    const stream = largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 1 });
    const streamBuf = Buffer.from(stream, "utf8");
    expect(streamBuf.byteLength).toBeGreaterThanOrEqual(TEN_MB);

    const whole = [streamBuf];
    const chunked = chunkBytes(stream, CHUNK_64K);
    expect(chunked.length).toBeGreaterThan(160);

    const channel = { appendLine: () => undefined } as never;
    const read = (cs: Buffer[]): number => {
      let dispatched = 0;
      const client = new OpencodeEventClient({ channel, onEvent: () => { dispatched++; } });
      const onChunk = (client as unknown as { onChunk(chunk: string): void }).onChunk.bind(client);
      const dec = new StringDecoder("utf8");
      for (const c of cs) { const t = dec.write(c); if (t) onChunk(t); }
      client.dispose();
      return dispatched;
    };
    expect(read(whole)).toBe(1);
    expect(read(chunked)).toBe(1);

    const { ratio, wholeMs, chunkedMs } = splitTimeRatio(read, whole, chunked);
    if (process.env.SPLIT_RATIO_LOG) {
      appendFileSync(process.env.SPLIT_RATIO_LOG, `sse_client ${ratio.toFixed(3)} ${wholeMs.toFixed(2)} ${chunkedMs.toFixed(2)}\n`);
    }
    expect(ratio, `chunked ${chunkedMs.toFixed(1)} ms vs whole ${wholeMs.toFixed(1)} ms`).toBeLessThanOrEqual(SPLIT_RATIO_FACTOR);
  }, 60_000);
});

describe("#1790 AC1 — SessionMultiplexProxy.openSseStream: 10 MB frame in 64 KB chunks ≤ 3× one-chunk time", () => {
  // Times sessionEventChunkReader — the exact per-chunk path openSseStream's
  // `data` handler runs (frame split + data: parse) — fed decoded chunks.
  it("sessionEventChunkReader: chunked ÷ whole ≤ 3, and the frame is parsed once either way", () => {
    const stream = largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 1 });
    const streamBuf = Buffer.from(stream, "utf8");
    expect(streamBuf.byteLength).toBeGreaterThanOrEqual(TEN_MB);

    const whole = [streamBuf];
    const chunked = chunkBytes(stream, CHUNK_64K);
    expect(chunked.length).toBeGreaterThan(160);

    const read = (cs: Buffer[]): number => {
      let events = 0;
      const push = sessionEventChunkReader(() => { events++; });
      const dec = new StringDecoder("utf8");
      for (const c of cs) { const t = dec.write(c); if (t) push(t); }
      return events;
    };
    expect(read(whole)).toBe(1);
    expect(read(chunked)).toBe(1);

    const { ratio, wholeMs, chunkedMs } = splitTimeRatio(read, whole, chunked);
    if (process.env.SPLIT_RATIO_LOG) {
      appendFileSync(process.env.SPLIT_RATIO_LOG, `session_mux ${ratio.toFixed(3)} ${wholeMs.toFixed(2)} ${chunkedMs.toFixed(2)}\n`);
    }
    expect(ratio, `chunked ${chunkedMs.toFixed(1)} ms vs whole ${wholeMs.toFixed(1)} ms`).toBeLessThanOrEqual(SPLIT_RATIO_FACTOR);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — CRLF blank line, including split across two chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("#1790 AC2 — SessionStreamFilter ends frames at a CRLF blank line, including one split across two chunks", () => {
  it("LF framing (\\n\\n): forwarded byte-identical with seq", () => {
    const frame = "id: 1\ndata: {\"a\":1}\n\n";
    const { output, seqs } = runFilter([Buffer.from(frame, "utf8")]);
    expect(output).toBe(frame);
    expect(seqs).toEqual([1]);
  });

  it("CRLF framing (\\r\\n\\r\\n): forwarded byte-identical with seq", () => {
    const frame = "id: 1\r\ndata: {\"a\":1}\r\n\r\n";
    const { output, seqs } = runFilter([Buffer.from(frame, "utf8")]);
    expect(output).toBe(frame);
    expect(seqs).toEqual([1]);
  });

  it("CRLF blank line split across two chunks — \\r\\n\\r | \\n", () => {
    const frame = "id: 1\r\ndata: {\"b\":2}\r\n\r\n";
    const all = Buffer.from(frame, "utf8");
    const cutAt = all.length - 1; // last byte is the \n of \r\n\r\n
    const { output, seqs } = runFilter([all.subarray(0, cutAt), all.subarray(cutAt)]);
    expect(output).toBe(frame);
    expect(seqs).toEqual([1]);
  });

  it("CRLF blank line split across two chunks — \\r\\n | \\r\\n", () => {
    const frame = "id: 2\r\ndata: {\"c\":3}\r\n\r\n";
    const all = Buffer.from(frame, "utf8");
    const cutAt = all.length - 2; // last two bytes are \r\n
    const { output, seqs } = runFilter([all.subarray(0, cutAt), all.subarray(cutAt)]);
    expect(output).toBe(frame);
    expect(seqs).toEqual([2]);
  });

  it("LF frame followed by CRLF frame: both forwarded byte-identical", () => {
    const f1 = "id: 1\ndata: {\"a\":1}\n\n";
    const f2 = "id: 2\r\ndata: {\"b\":2}\r\n\r\n";
    const { output, seqs } = runFilter([Buffer.from(f1 + f2, "utf8")]);
    expect(output).toBe(f1 + f2);
    expect(seqs).toEqual([1, 2]);
  });
});

describe("#1790 AC2 — OpencodeEventClient ends frames at a CRLF blank line, including one split across two chunks", () => {
  it("LF-terminated frame is dispatched", async () => {
    const events = await runClient([Buffer.from('data: {"type":"session.idle"}\n\n', "utf8")]);
    expect(events.some((e) => e.type === "session.idle")).toBe(true);
  });

  it("CRLF-terminated frame is dispatched (\\r\\n\\r\\n must be recognized as a frame boundary)", async () => {
    const events = await runClient([Buffer.from('data: {"type":"session.crlf"}\r\n\r\n', "utf8")]);
    expect(events.some((e) => e.type === "session.crlf")).toBe(true);
  });

  it("CRLF frame split at the delimiter (\\r\\n\\r | \\n) — boundary straddling two chunks", async () => {
    const frame = Buffer.from('data: {"type":"session.split_crlf"}\r\n\r\n', "utf8");
    const events = await runClient([frame.subarray(0, frame.length - 1), frame.subarray(frame.length - 1)]);
    expect(events.some((e) => e.type === "session.split_crlf")).toBe(true);
  });
});

describe("#1790 AC2 — SessionMultiplexProxy.openSseStream ends frames at a CRLF blank line, including one split across two chunks", () => {
  it("CRLF-terminated event is dispatched via next()", async () => {
    const frame = Buffer.from('data: {"type":"crlf_event","sessionID":"ses_large"}\r\n\r\n', "utf8");
    const events = await runMuxStream([frame]);
    expect(events.some((e) => String(e.type) === "crlf_event")).toBe(true);
  }, 10_000);

  it("CRLF frame split at the delimiter (\\r\\n\\r | \\n) across two chunks: event dispatched", async () => {
    const frame = Buffer.from('data: {"type":"crlf_split","sessionID":"ses_large"}\r\n\r\n', "utf8");
    const events = await runMuxStream([frame.subarray(0, frame.length - 1), frame.subarray(frame.length - 1)]);
    expect(events.some((e) => String(e.type) === "crlf_split")).toBe(true);
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — byte-identical framing: multi-line data, event names, ids, retry
//        at every byte offset
// ─────────────────────────────────────────────────────────────────────────────

describe("#1790 AC3 — SessionStreamFilter: framing unchanged at every byte offset", () => {
  it("multi-line data, id, retry, event: fields — whole and at every byte offset yield the same frames byte-identical", () => {
    const frames = [
      "id: 1\ndata: {\"a\":1}\n\n",
      "event: message\nid: 2\nretry: 5000\ndata: {\"a\":\ndata: 2}\n\n",
      "id: 3\r\ndata: {\"b\":3}\r\n\r\n",
      ": keep-alive\n\n",
      "id: 4\ndata: {\"c\":4}\n\n",
    ];
    const stream = frames.join("");
    const wholeOut = runFilter([Buffer.from(stream, "utf8")]).output;
    expect(wholeOut).toBe(stream);

    for (const delivery of everySplit(stream)) {
      const got = runFilter(delivery).output;
      if (got !== stream) {
        expect({ cuts: delivery.map((c) => c.length), got }).toEqual({
          cuts: delivery.map((c) => c.length),
          expected: stream,
        });
      }
    }
  });
});

describe("#1790 AC3 — SessionStreamFilter: a lookback never crosses a frame boundary", () => {
  // A stray line feed right after a frame is not a blank line of its own: it
  // starts the next block (as the pre-#1790 `indexOf("\n\n")` splitter had it),
  // so a deduped block is dropped together with it.
  const stream = "id: 1\ndata: a\n\n\nid: 2\ndata: b\n\nid: 3\r\ndata: c\r\n\r\n\r\nid: 4\ndata: d\n\n";
  const expected = "id: 3\r\ndata: c\r\n\r\n";

  it("drops the deduped blocks whole, at every byte offset", () => {
    const want = { output: expected + "\r\nid: 4\ndata: d\n\n", seqs: [3, 4] };
    expect(runFilter([Buffer.from(stream, "utf8")], 2)).toEqual(want);
    for (const delivery of everySplit(stream)) {
      expect({ cuts: delivery.map((c) => c.length), ...runFilter(delivery, 2) }).toEqual({
        cuts: delivery.map((c) => c.length),
        ...want,
      });
    }
  });

  it("a frame boundary resets the lookback: dropping seq ≤ 4 drops everything", () => {
    for (const delivery of [[Buffer.from(stream, "utf8")], ...everySplit(stream)]) {
      expect(runFilter(delivery, 4)).toEqual({ output: "", seqs: [] });
    }
  });
});

describe("#1790 AC3 — OpencodeEventClient: multiple events in one delivery, and CRLF framing", () => {
  it("two LF events in one stream are both dispatched", async () => {
    const events = await runClient([
      Buffer.from('data: {"type":"ev.1"}\n\ndata: {"type":"ev.2"}\n\n', "utf8"),
    ]);
    expect(events.some((e) => e.type === "ev.1")).toBe(true);
    expect(events.some((e) => e.type === "ev.2")).toBe(true);
  });

  it("two CRLF events in one stream are both dispatched", async () => {
    const events = await runClient([
      Buffer.from('data: {"type":"crlf.1"}\r\n\r\ndata: {"type":"crlf.2"}\r\n\r\n', "utf8"),
    ]);
    expect(events.some((e) => e.type === "crlf.1")).toBe(true);
    expect(events.some((e) => e.type === "crlf.2")).toBe(true);
  });
});

describe("#1790 AC3 — SessionMultiplexProxy.openSseStream: multiple events parsed correctly", () => {
  it("two LF events in one delivery are both dispatched", async () => {
    const f1 = 'data: {"type":"msg.1","sessionID":"ses_large"}\n\n';
    const f2 = 'data: {"type":"msg.2","sessionID":"ses_large"}\n\n';
    const events = await runMuxStream([Buffer.from(f1 + f2, "utf8")]);
    expect(events.some((e) => String(e.type) === "msg.1")).toBe(true);
    expect(events.some((e) => String(e.type) === "msg.2")).toBe(true);
  }, 10_000);

  it("two CRLF events in one delivery are both dispatched", async () => {
    const f1 = 'data: {"type":"crlf.1","sessionID":"ses_large"}\r\n\r\n';
    const f2 = 'data: {"type":"crlf.2","sessionID":"ses_large"}\r\n\r\n';
    const events = await runMuxStream([Buffer.from(f1 + f2, "utf8")]);
    expect(events.some((e) => String(e.type) === "crlf.1")).toBe(true);
    expect(events.some((e) => String(e.type) === "crlf.2")).toBe(true);
  }, 10_000);
});
