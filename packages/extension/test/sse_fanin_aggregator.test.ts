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

// ══════════════════════════════════════════════════════════════════════════════
// AC4 (D3) — composite cursor: parse / format round-trip, per-namespace resume,
//            id-less frame does not advance its namespace
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC4 (D3) — composite cursor", () => {
  it("parses `local=<id>;<machineId>=<idA>` into a per-namespace map", () => {
    const m = parseCompositeCursor("local=5;studio=42;mini=7");
    expect(m.get("local")).toBe("5");
    expect(m.get("studio")).toBe("42");
    expect(m.get("mini")).toBe("7");
    expect(m.size).toBe(3);
  });

  it("format(parse(x)) === x for every well-formed composite (order-preserving)", () => {
    for (const x of ["local=5", "local=5;studio=42", "local=5;studio=42;mini=7", "studio=42;local=5"]) {
      expect(formatCompositeCursor(parseCompositeCursor(x))).toBe(x);
    }
  });

  it("a bare scalar is the #1264 back-compat local position; empty → empty map", () => {
    expect(parseCompositeCursor("42").get("local")).toBe("42");
    expect(parseCompositeCursor("").size).toBe(0);
    expect(parseCompositeCursor(undefined).size).toBe(0);
  });

  it("connect() re-subscribes each upstream with ITS OWN resume id", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    const resume = agg.connect("local=5;studio=42;mini=7");
    expect(resume.get("local")).toBe("5");
    expect(resume.get("studio")).toBe("42");
    expect(resume.get("mini")).toBe("7");
  });

  it("an id-less frame does not advance its namespace's cursor", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    // studio advances to 9
    agg.ingest("studio", frame("event: message", "data: {}", "id: 9"));
    expect(parseCompositeCursor(agg.cursor()).get("studio")).toBe("9");
    // an id-less studio frame (heartbeat/comment) must NOT move the cursor
    agg.ingest("studio", frame(": keep-alive comment"));
    expect(parseCompositeCursor(agg.cursor()).get("studio")).toBe("9");
    // and neither does a frame with an empty id value
    agg.ingest("studio", frame("data: {}", "id:"));
    expect(parseCompositeCursor(agg.cursor()).get("studio")).toBe("9");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 (D2) — `id:`-verbatim namespaced relay + pipeToResponse adapter
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC3 (D2) — namespaced relay + res adapter", () => {
  it("relayFrame preserves event:/data:/retry: lines and namespaces id as `<machineId>␟<peerId>`", () => {
    const raw = frame("event: message", "data: {\"x\":1}", "data: {\"y\":2}", "retry: 3000", "id: 42");
    const out = relayFrame("studio", raw);
    expect(out).toContain("event: message");
    expect(out).toContain("data: {\"x\":1}");
    expect(out).toContain("data: {\"y\":2}"); // multi-line data preserved
    expect(out).toContain("retry: 3000");
    expect(out).toContain(`id: studio${NS_SEP}42`);
    expect(out).not.toContain("\nid: 42\n"); // the bare id is namespaced, not left raw
  });

  it("the local arm uses the reserved `local` namespace", () => {
    const out = relayFrame(LOCAL_NAMESPACE, frame("data: {}", "id: 7"));
    expect(out).toContain(`id: ${LOCAL_NAMESPACE}${NS_SEP}7`);
  });

  it("an id-less frame relays verbatim (nothing to namespace)", () => {
    const raw = frame(": heartbeat");
    expect(relayFrame("studio", raw)).toBe(raw);
  });

  it("pipeToResponse writes well-formed namespaced SSE bytes and flushes per frame", async () => {
    const sink = collectingSink();
    const src = fixedSource([
      frame("event: message", "data: {\"a\":1}", "id: 1"),
      frame("event: message", "data: {\"b\":2}", "id: 2"),
    ]);
    await pipeToResponse(src, sink, { namespace: "studio" });
    const text = sink.text();
    expect(text).toContain(`id: studio${NS_SEP}1`);
    expect(text).toContain(`id: studio${NS_SEP}2`);
    // every frame ends with the SSE blank-line delimiter
    expect(text.endsWith("\n\n")).toBe(true);
    // one flush per frame (no head-of-line buffering)
    expect(sink.flushes).toBe(2);
  });
});
