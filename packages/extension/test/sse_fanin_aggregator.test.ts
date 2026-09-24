// sse_fanin_aggregator.test.ts — #1511 (Fleet Studio, ADR 0033 impl): the
// origin-side SSE fan-in aggregator + lossless resume, unit-tested on a single
// host per the ADR test plan. Pins the 7 ACs (D1–D4 + decisions A/A/B):
//
//   AC1 (D4) — flag-OFF / zero-peer BYTE-IDENTITY: the aggregate stream equals
//              the local stream frame-for-frame; `?lastEventID=local=<id>`
//              (and bare `<id>`) resume the local arm. THE FIRST TEST — the
//              #1264 regression guard.
//   AC2 (D1) — fan-in membership from the SessionOwnerMap; unreachable owner →
//              an honest comment frame, never a silent gap.
//   AC3 (D2) — `id:`-verbatim namespaced relay (`<machineId>␟<peerId>`, U+001F)
//              + a `pipeToResponse(source, sink)` adapter that writes well-formed
//              SSE bytes and flushes per frame.
//   AC4 (D3) — composite cursor: parse `local=<id>;<machineId>=<idA>`,
//              `format(parse(x)) === x`, per-namespace resume, an id-less frame
//              does not advance its namespace.
//   AC5 (A)  — per-peer auth: each upstream reads its OWN token from the
//              peer-store; the hub credential is NEVER forwarded; absent/invalid
//              token → a named unavailable source, never a silent local fallback.
//   AC6 (A)  — focus snapshot as the FIRST frame on `local` at connect AND every
//              reconnect; absent focus → a named empty snapshot, not a gap.
//   AC7 (B)  — per-namespace bounded buffers: one overflowing peer degrades in
//              isolation; the other namespaces and the local arm keep flowing.
import { describe, it, expect } from "vitest";
import {
  SseFanInAggregator,
  pipeToResponse,
  relayFrame,
  LOCAL_NAMESPACE,
  NS_SEP,
  type SseSink,
  type SseFrameSource,
} from "../src/amicode_service/sse_fanin_aggregator";
import {
  parseCompositeCursor,
  formatCompositeCursor,
} from "../src/amicode_service/sse_composite_cursor";

// ── test helpers ──────────────────────────────────────────────────────────────

/** A collecting sink that records every write + flush. */
function collectingSink(): SseSink & { text(): string; flushes: number } {
  const chunks: string[] = [];
  let flushes = 0;
  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    flush() {
      flushes += 1;
    },
    text() {
      return chunks.join("");
    },
    get flushes() {
      return flushes;
    },
  };
}

/** Build a single SSE frame block (delimiter-inclusive) from lines. */
function frame(...lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

/** A frame source that yields a fixed list of raw frames, then ends. */
function fixedSource(frames: string[]): SseFrameSource {
  let i = 0;
  let closed = false;
  return {
    next(): Promise<string | null> {
      if (closed || i >= frames.length) return Promise.resolve(null);
      return Promise.resolve(frames[i++]);
    },
    close() {
      closed = true;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 (D4) — flag-OFF / zero-peer BYTE-IDENTITY (THE FIRST TEST)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC1 (D4) — fleet-of-one byte-identity is the #1264 regression guard", () => {
  it("with zero peers, the aggregate stream is frame-for-frame identical to the local source", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect(); // no cursor, no peers, no focus provider → pure passthrough

    const f1 = frame("event: message", "data: {\"a\":1}", "id: 1");
    const f2 = frame("event: message", "data: {\"b\":2}", "id: 2");
    const f3 = frame("data: {\"c\":3}", "id: 3"); // no event: line — still verbatim
    agg.ingest(LOCAL_NAMESPACE, f1);
    agg.ingest(LOCAL_NAMESPACE, f2);
    agg.ingest(LOCAL_NAMESPACE, f3);

    // BYTE-IDENTICAL: no id rewrite, no namespacing, no reordering, no loss.
    expect(sink.text()).toBe(f1 + f2 + f3);
  });

  it("`?lastEventID=local=<id>` AND bare `<id>` both resume the local arm at <id>", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });

    const composite = agg.connect("local=42");
    expect(composite.get(LOCAL_NAMESPACE)).toBe("42");

    // #1264 back-compat: a bare scalar cursor is the local arm's position.
    const sink2 = collectingSink();
    const agg2 = new SseFanInAggregator({ sink: sink2 });
    const bare = agg2.connect("42");
    expect(bare.get(LOCAL_NAMESPACE)).toBe("42");
  });

  it("no focus provider → the connect emits nothing until the first real frame (strict passthrough)", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    expect(sink.text()).toBe(""); // no prepended frames when fleet-of-one + no focus
  });
});
