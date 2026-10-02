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
  resolveUpstreamAuth,
  honestSourceComment,
  deriveMembership,
  LOCAL_NAMESPACE,
  NS_SEP,
  type SseSink,
  type SseFrameSource,
} from "../src/amicode_service/sse_fanin_aggregator";
import {
  parseCompositeCursor,
  formatCompositeCursor,
} from "../src/amicode_service/sse_composite_cursor";
import { SessionOwnerMap } from "../src/amicode_service/session_multiplexer";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
import type { PeerTokenRead } from "../src/amicode_service/fleet_peer_store";

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

// ── AC2/AC5 shared token fixtures ─────────────────────────────────────────────

const okToken = (baseUrl: string, token: string): PeerTokenRead => ({ ok: true, credential: { baseUrl, token } });
const absentToken: PeerTokenRead = { ok: false, reason: "absent" };

/** A SessionOwnerMap seeded with the given (sessionId → ownerMachineId) pairs,
 *  each tagged as a remote (is_local:false) owned session. */
function ownerMapOf(pairs: Array<[string, string]>): SessionOwnerMap {
  const m = new SessionOwnerMap();
  m.update(pairs.map(([id, owner]) => ({ id, amicode_owner: { owner_machine_id: owner, owner_name: owner, is_local: false } })));
  return m;
}

// ══════════════════════════════════════════════════════════════════════════════
// AC2 (D1) — fan-in membership from the SessionOwnerMap; unreachable → comment
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC2 (D1) — fan-in membership", () => {
  const localId = "macbook";
  const reachableAll = () => true;

  it("opens one arm per reachable owner-peer holding ≥1 owned session (local excluded)", () => {
    const ownerMap = ownerMapOf([["s1", "studio"], ["s2", "studio"], ["s3", "mini"], ["s4", localId]]);
    const members = deriveMembership({
      ownerMachineIds: ownerMap.ownerMachineIds(),
      localMachineId: localId,
      reachable: reachableAll,
      peerToken: (id) => okToken(`http://${id}`, `tok-${id}`),
    });
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership(members);
    expect(agg.activeArms().sort()).toEqual(["mini", "studio"]); // NOT the local owner
  });

  it("peers are added and removed as the SessionOwnerMap changes", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    const derive = (ownerMap: SessionOwnerMap) =>
      deriveMembership({
        ownerMachineIds: ownerMap.ownerMachineIds(),
        localMachineId: localId,
        reachable: reachableAll,
        peerToken: (id) => okToken(`http://${id}`, `tok-${id}`),
      });

    agg.setMembership(derive(ownerMapOf([["s1", "studio"], ["s3", "mini"]])));
    expect(agg.activeArms().sort()).toEqual(["mini", "studio"]);

    // mini's session ends → mini's arm is removed; studio stays.
    agg.setMembership(derive(ownerMapOf([["s1", "studio"]])));
    expect(agg.activeArms()).toEqual(["studio"]);

    // a new owner appears → its arm is added.
    agg.setMembership(derive(ownerMapOf([["s1", "studio"], ["s9", "lab"]])));
    expect(agg.activeArms().sort()).toEqual(["lab", "studio"]);
  });

  it("an unreachable owner emits an honest comment frame, never a silent gap", () => {
    const ownerMap = ownerMapOf([["s1", "studio"]]);
    const members = deriveMembership({
      ownerMachineIds: ownerMap.ownerMachineIds(),
      localMachineId: localId,
      reachable: () => false, // studio is dark
      peerToken: (id) => okToken(`http://${id}`, `tok-${id}`),
    });
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership(members);

    expect(agg.activeArms()).toEqual([]); // studio is NOT an active arm
    expect(agg.unavailableSources()).toEqual(["studio"]); // but it is NAMED
    expect(sink.text()).toBe(honestSourceComment("studio", "peer-unreachable"));
    expect(sink.text()).toContain(": amicode.fleet source studio unavailable");
  });

  it("the comment is emitted once on transition, not spammed while the peer stays dark", () => {
    const ownerMap = ownerMapOf([["s1", "studio"]]);
    const members = deriveMembership({
      ownerMachineIds: ownerMap.ownerMachineIds(),
      localMachineId: localId,
      reachable: () => false,
      peerToken: (id) => okToken(`http://${id}`, `tok-${id}`),
    });
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership(members);
    agg.setMembership(members); // still dark — no new comment
    expect(sink.text()).toBe(honestSourceComment("studio", "peer-unreachable"));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC5 (decision A) — per-peer auth: own token, never the hub credential
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC5 (A) — per-peer upstream auth", () => {
  it("each upstream authenticates with THAT peer's own token", () => {
    const studio = resolveUpstreamAuth("studio", okToken("http://studio", "tok-studio"));
    const mini = resolveUpstreamAuth("mini", okToken("http://mini", "tok-mini"));
    expect(studio.ok && studio.authHeader).toBe(peerAuthHeader("tok-studio"));
    expect(mini.ok && mini.authHeader).toBe(peerAuthHeader("tok-mini"));
    // distinct peers → distinct credentials
    expect(studio.ok && mini.ok && studio.authHeader !== mini.authHeader).toBe(true);
  });

  it("the hub-mint credential is NEVER forwarded to a peer upstream", () => {
    const hubToken = "HUB-MINT-CREDENTIAL-must-not-leak";
    const auth = resolveUpstreamAuth("studio", okToken("http://studio", "tok-studio"));
    // the header is derived solely from the peer's own token — the hub token is
    // not even an input to resolveUpstreamAuth, so it cannot appear.
    expect(auth.ok && auth.authHeader).toBe(peerAuthHeader("tok-studio"));
    expect(auth.ok && auth.authHeader.includes(hubToken)).toBe(false);
    expect(auth.ok && auth.authHeader).not.toBe(peerAuthHeader(hubToken));
  });

  it("an absent/invalid peer token is a NAMED unavailable source, never a silent local fallback", () => {
    const absent = resolveUpstreamAuth("dark", absentToken);
    expect(absent.ok).toBe(false);
    expect(!absent.ok && absent.reason).toBe("token-absent");
    expect(!absent.ok && absent.machineId).toBe("dark"); // named, not dropped

    // and through membership: a token-less owner-peer is named unavailable +
    // NOT an active arm — it never resolves to local.
    const ownerMap = ownerMapOf([["s1", "dark"]]);
    const members = deriveMembership({
      ownerMachineIds: ownerMap.ownerMachineIds(),
      localMachineId: "macbook",
      reachable: () => true, // reachable, but no token
      peerToken: () => absentToken,
    });
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership(members);
    expect(agg.activeArms()).toEqual([]);
    expect(agg.unavailableSources()).toEqual(["dark"]);
    expect(sink.text()).toContain(": amicode.fleet source dark unavailable");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC6 (decision A) — focus snapshot as the FIRST local-namespace frame
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC6 (A) — focus-on-connect snapshot", () => {
  it("emits the current focus as the FIRST frame on the local namespace at connect", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({
      sink,
      focusSnapshot: () => ({ focusedMachineId: "studio", isHome: false, absent: false }),
    });
    agg.connect();
    // the focus frame is the very first thing written, before any event frame
    expect(sink.text().startsWith("event: amicode.fleet.focus\n")).toBe(true);
    expect(sink.text()).toContain("\"focusedMachineId\":\"studio\"");

    // a following local event frame comes AFTER the focus seed
    agg.ingest(LOCAL_NAMESPACE, frame("data: {}", "id: 1"));
    const idx = sink.text().indexOf("amicode.fleet.focus");
    const evtIdx = sink.text().indexOf("id: 1");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(evtIdx).toBeGreaterThan(idx);
  });

  it("re-emits the focus snapshot on EVERY reconnect (self-healing cold-seed)", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({
      sink,
      focusSnapshot: () => ({ focusedMachineId: "studio", isHome: false, absent: false }),
    });
    agg.connect("local=1"); // first connect
    agg.connect("local=5"); // reconnect
    const count = sink.text().split("event: amicode.fleet.focus").length - 1;
    expect(count).toBe(2); // one focus frame per connect
  });

  it("absent focus is a NAMED empty snapshot, not a missing frame", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink, focusSnapshot: () => undefined });
    agg.connect();
    expect(sink.text()).toContain("event: amicode.fleet.focus"); // frame present
    expect(sink.text()).toContain("\"empty\":true"); // named empty, not missing
    expect(sink.text()).toContain("\"isHome\":true");
  });

  // #1522 AC2 — home distinction: isHome:true, absent:false (the named-home case
  // stays distinct from named-empty/absent).
  it("home focus (no machineId) → isHome:true, absent:false, no empty flag", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({
      sink,
      focusSnapshot: () => ({ isHome: true, absent: false }),
    });
    agg.connect();
    const payload = JSON.parse(
      sink.text().split("data: ")[1].split("\n")[0],
    );
    expect(payload.isHome).toBe(true);
    expect(payload.absent).toBe(false);
    expect(payload.empty).toBeUndefined(); // real provider, NOT the named-empty fallback
    expect(payload.focusedMachineId).toBeUndefined();
  });

  // #1522 AC3 — named absence: the focused peer is not in the available set.
  it("named absence → absent:true with reason from the provider", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({
      sink,
      focusSnapshot: () => ({
        focusedMachineId: "dark-peer",
        isHome: false,
        absent: true,
        reason: "peer-unavailable",
      }),
    });
    agg.connect();
    const payload = JSON.parse(
      sink.text().split("data: ")[1].split("\n")[0],
    );
    expect(payload.focusedMachineId).toBe("dark-peer");
    expect(payload.isHome).toBe(false);
    expect(payload.absent).toBe(true);
    expect(payload.reason).toBe("peer-unavailable");
    expect(payload.empty).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC7 (decision B) — per-namespace bounded back-pressure, degrade in isolation
// ══════════════════════════════════════════════════════════════════════════════
describe("#1511 AC7 (B) — per-namespace back-pressure", () => {
  /** A sink whose downstream can be blocked; `write` returns false while
   *  blocked (the Node res.write backpressure signal) but still records the
   *  chunk (a blocked res still queues the current write). */
  function controllableSink() {
    const chunks: string[] = [];
    let blocked = false;
    return {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return !blocked;
      },
      flush() {},
      block() {
        blocked = true;
      },
      unblock() {
        blocked = false;
      },
      text() {
        return chunks.join("");
      },
      count(ns: string) {
        return (this.text().match(new RegExp(`"ns":"${ns}"`, "g")) ?? []).length;
      },
    };
  }

  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("one overflowing peer drops in ISOLATION; the other namespaces and local keep flowing", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink, bufferBound: 2 });
    agg.connect();
    agg.setMembership([
      { machineId: "studio", reachable: true, token: "tok-studio" },
      { machineId: "mini", reachable: true, token: "tok-mini" },
    ]);

    sink.block(); // the shared downstream stalls
    // studio floods: 1 delivered (fills the pipe), 2 & 3 buffered, 4+ dropped
    agg.ingest("studio", nsFrame("studio", 1));
    agg.ingest("studio", nsFrame("studio", 2));
    agg.ingest("studio", nsFrame("studio", 3));
    agg.ingest("studio", nsFrame("studio", 4));
    agg.ingest("studio", nsFrame("studio", 5));
    // mini + local stay within their independent bounds (no drops)
    agg.ingest("mini", nsFrame("mini", 1));
    agg.ingest("mini", nsFrame("mini", 2));
    agg.ingest(LOCAL_NAMESPACE, nsFrame("local", 1));

    // studio overflowed (its buffer dropped frames); mini + local did NOT
    expect(agg.dropped("studio")).toBeGreaterThan(0);
    expect(agg.dropped("mini")).toBe(0);
    expect(agg.dropped(LOCAL_NAMESPACE)).toBe(0);

    // downstream drains → the buffered frames flush
    sink.unblock();
    agg.resume();

    // ISOLATION: mini + local delivered EVERY frame; studio delivered only up to
    // its bound (the rest dropped — the gap D3 resumes on reconnect).
    expect(sink.count("mini")).toBe(2);
    expect(sink.count("local")).toBe(1);
    expect(sink.count("studio")).toBeLessThan(5);
    expect(sink.count("studio")).toBeGreaterThanOrEqual(1);

    // studio's cursor sits at the last DELIVERED id, never a dropped one —
    // so a reconnect with this composite replays the gap losslessly (D3 × B).
    const studioCursor = Number(parseCompositeCursor(agg.cursor()).get("studio"));
    expect(studioCursor).toBeLessThan(5);
    // mini + local cursors reflect full delivery
    expect(parseCompositeCursor(agg.cursor()).get("mini")).toBe("2");
    expect(parseCompositeCursor(agg.cursor()).get("local")).toBe("1");
  });

  it("steady state (downstream flowing) never buffers — frames deliver directly", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink, bufferBound: 1 });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    // never blocked: every frame flows, nothing is dropped even past the bound
    for (let n = 1; n <= 5; n++) agg.ingest("studio", nsFrame("studio", n));
    expect(agg.dropped("studio")).toBe(0);
    expect(sink.count("studio")).toBe(5);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1617 — the fan-in relay never re-armed backpressure (flowing stuck false).
// The core fix, at the aggregator seam: an `onBackpressure` hook the driver wires
// to pause upstreams; a gap signal emitted at resume() time (never into a
// backpressured sink) when overflow dropped frames; and the wedge repro — one
// trip-frame plus a single stranded frame heals on resume with NO overflow.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1617 — backpressure re-arm + gap signal", () => {
  function controllableSink() {
    const chunks: string[] = [];
    let blocked = false;
    return {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return !blocked;
      },
      flush() {},
      block() {
        blocked = true;
      },
      unblock() {
        blocked = false;
      },
      text() {
        return chunks.join("");
      },
      count(ns: string) {
        return (this.text().match(new RegExp(`"ns":"${ns}"`, "g")) ?? []).length;
      },
    };
  }
  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("the WEDGE (no overflow): one trip-frame strands one frame behind it; resume() delivers BOTH in order", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink, bufferBound: 256 });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);

    sink.block(); // the shared downstream backpressures on the NEXT write
    agg.ingest("studio", nsFrame("studio", 1)); // trip-frame: written, flips flowing=false
    agg.ingest("studio", nsFrame("studio", 2)); // stranded in the buffer — NOT delivered
    // The wedge: frame 2 sits buffered, flowing is false, nothing overflowed.
    expect(sink.count("studio")).toBe(1);
    expect(agg.dropped("studio")).toBe(0);

    // The downstream drains and resume() re-arms flowing + flushes in order.
    sink.unblock();
    agg.resume();
    expect(sink.count("studio")).toBe(2);
    // order preserved: frame 1 before frame 2
    expect(sink.text().indexOf('"n":1')).toBeLessThan(sink.text().indexOf('"n":2'));
    // cursor advanced past both delivered frames
    expect(parseCompositeCursor(agg.cursor()).get("studio")).toBe("2");
  });

  it("onBackpressure fires exactly when a write() returns false (the driver's upstream-pause hook)", () => {
    const sink = controllableSink();
    let backpressureCalls = 0;
    const agg = new SseFanInAggregator({ sink, onBackpressure: () => (backpressureCalls += 1) });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);

    // flowing: no backpressure signal
    agg.ingest("studio", nsFrame("studio", 1));
    expect(backpressureCalls).toBe(0);

    // the next write backpressures → onBackpressure fires once
    sink.block();
    agg.ingest("studio", nsFrame("studio", 2));
    expect(backpressureCalls).toBe(1);

    // subsequent frames buffer (already not flowing) — no repeated signal storm
    agg.ingest("studio", nsFrame("studio", 3));
    expect(backpressureCalls).toBe(1);
  });

  it("resume() emits EXACTLY ONE id-less gap frame naming the dropped namespaces and zeroes their drop counters", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink, bufferBound: 1 });
    agg.connect();
    agg.setMembership([
      { machineId: "studio", reachable: true, token: "tok-studio" },
      { machineId: "mini", reachable: true, token: "tok-mini" },
    ]);

    sink.block();
    // studio overflows its bound (1 delivered, 1 buffered, rest dropped)
    for (let n = 1; n <= 5; n++) agg.ingest("studio", nsFrame("studio", n));
    // mini stays within bound (no drops)
    agg.ingest("mini", nsFrame("mini", 1));
    expect(agg.dropped("studio")).toBeGreaterThan(0);
    expect(agg.dropped("mini")).toBe(0);

    sink.unblock();
    agg.resume();

    const gapMatches = sink.text().match(/event: amicode\.sync\.gap/g) ?? [];
    expect(gapMatches.length).toBe(1);
    // drop counters zeroed after the gap is emitted
    expect(agg.dropped("studio")).toBe(0);

    // HARD shape reqs (issue Data Contracts): the gap frame carries a `data:`
    // line (SSE drops a data-less frame) and its JSON has NO top-level `payload`
    // key (the client routes on `"payload" in event`).
    const gapFrame = sink
      .text()
      .split("\n\n")
      .find((f) => f.includes("amicode.sync.gap"))!;
    expect(gapFrame).toContain("data:");
    const dataLine = gapFrame.split("\n").find((l) => l.startsWith("data:"))!;
    const parsed = JSON.parse(dataLine.slice("data:".length).trim());
    expect("payload" in parsed).toBe(false);
    expect(parsed.type).toBe("amicode.sync.gap");
    expect(parsed.namespaces).toContain("studio");
    // id-less: never advances any namespace's cursor
    expect(gapFrame.split("\n").some((l) => l.startsWith("id:"))).toBe(false);
  });

  it("resume() with NO drops emits NO gap frame", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink, bufferBound: 256 });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    sink.block();
    agg.ingest("studio", nsFrame("studio", 1));
    agg.ingest("studio", nsFrame("studio", 2)); // buffered, not dropped
    sink.unblock();
    agg.resume();
    expect(sink.text()).not.toContain("amicode.sync.gap");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // #1617 (follow-up) — the FLEET-OF-ONE wedge. The composite-mode fix above never
  // touches the zero-peer verbatim branch, which ignored `write() === false`
  // entirely: a large LOCAL frame tripped backpressure and the next frame (the
  // `session.status: idle` that clears the rail) was stranded with nothing to
  // re-arm delivery — the "local sessions freeze until reload" symptom on a solo
  // machine. The verbatim path must honor backpressure too, WITHOUT changing a
  // single byte (the #1264 guard: no namespacing, no composite-id rewrite).
  // ────────────────────────────────────────────────────────────────────────────
  it("the FLEET-OF-ONE wedge: a large local frame strands the next; resume() flushes both VERBATIM", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect(); // zero peers → the §D4 verbatim branch

    const f1 = frame("event: message", 'data: {"big":"tool-output"}', "id: 7");
    const f2 = frame("event: session.status", 'data: {"status":"idle"}', "id: 8"); // the rail-clearing frame

    sink.block(); // the socket fills on the NEXT write
    agg.ingest(LOCAL_NAMESPACE, f1); // trip-frame: written, write()→false
    agg.ingest(LOCAL_NAMESPACE, f2); // the idle frame — MUST NOT be lost/stranded past drain

    // Before drain: only the trip-frame is out; the idle frame is held.
    expect(sink.text()).toBe(f1);

    // Socket drains → resume() flushes the stranded frame.
    sink.unblock();
    agg.resume();

    // BYTE-IDENTICAL flush (the #1264 guard): both frames verbatim, in order, no
    // composite id, no namespacing, no gap frame (no overflow occurred).
    expect(sink.text()).toBe(f1 + f2);
    expect(sink.text()).not.toContain("local\u001f"); // no NS_SEP namespacing
    expect(sink.text()).not.toContain("local=8"); // no composite-cursor id rewrite
    expect(sink.text()).not.toContain("amicode.sync.gap");
  });

  it("fleet-of-one never backpressured stays strictly byte-identical (the #1264 guard, unchanged)", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    const f1 = frame("event: message", 'data: {"a":1}', "id: 1");
    const f2 = frame("data: {\"c\":3}", "id: 3"); // no event: line
    agg.ingest(LOCAL_NAMESPACE, f1);
    agg.ingest(LOCAL_NAMESPACE, f2);
    expect(sink.text()).toBe(f1 + f2); // untouched fast path
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1638 — reconnect cursor + gap + hardening (Step 0 = NO REPLAY). The upstream
// /global/event route does NOT replay on ?lastEventID (evidenced in the issue),
// so a re-opened arm resumes from the last-DELIVERED id (bookkeeping) AND a non-
// initial re-open must force a client refetch via one id-less amicode.sync.gap —
// but ONLY in composite mode (peerArms>0); in fleet-of-one a synthetic frame in
// the verbatim stream would break #1264, so NO gap is emitted there.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1638 — per-namespace cursor accessor (cursorFor)", () => {
  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("cursorFor(ns) returns the live last-DELIVERED id for that namespace, advancing per delivered frame", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);

    // before any frame: no delivered id for studio
    expect(agg.cursorFor("studio")).toBeUndefined();

    agg.ingest("studio", nsFrame("studio", 1));
    expect(agg.cursorFor("studio")).toBe("1"); // advanced to the delivered id

    agg.ingest("studio", nsFrame("studio", 2));
    expect(agg.cursorFor("studio")).toBe("2"); // advanced again
  });

  it("cursorFor tracks the LOCAL namespace on the verbatim (fleet-of-one) path too", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect(); // zero peers → verbatim
    agg.ingest(LOCAL_NAMESPACE, nsFrame("local", 5));
    expect(agg.cursorFor(LOCAL_NAMESPACE)).toBe("5");
  });

  it("an id-less frame does NOT advance cursorFor (matches the composite-cursor invariant)", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    agg.ingest("studio", nsFrame("studio", 1));
    agg.ingest("studio", frame(": heartbeat")); // id-less
    expect(agg.cursorFor("studio")).toBe("1"); // unchanged by the id-less frame
  });
});

describe("#1638 — composite-mode reopenArm emits exactly one id-less gap; fleet-of-one emits none", () => {
  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("COMPOSITE MODE: a non-initial re-open emits EXACTLY ONE id-less amicode.sync.gap naming that namespace", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    agg.ingest("studio", nsFrame("studio", 1));

    agg.reopenArm("studio"); // the #1601 re-open path (arm dropped, reconcile re-opens)

    const gapMatches = sink.text().match(/event: amicode\.sync\.gap/g) ?? [];
    expect(gapMatches.length).toBe(1);
    const gapFrame = sink.text().split("\n\n").find((f) => f.includes("amicode.sync.gap"))!;
    // client shape reqs: a data: line, no top-level payload key, and id-less
    expect(gapFrame).toContain("data:");
    const dataLine = gapFrame.split("\n").find((l) => l.startsWith("data:"))!;
    const parsed = JSON.parse(dataLine.slice("data:".length).trim());
    expect("payload" in parsed).toBe(false);
    expect(parsed.type).toBe("amicode.sync.gap");
    expect(parsed.namespaces).toContain("studio");
    expect(gapFrame.split("\n").some((l) => l.startsWith("id:"))).toBe(false);
  });

  it("FLEET-OF-ONE (zero peers): a re-open emits NO gap frame and the stream stays byte-identical (#1264)", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect(); // zero peers → verbatim, no focus provider
    const f1 = frame("event: message", 'data: {"a":1}', "id: 1");
    agg.ingest(LOCAL_NAMESPACE, f1);

    agg.reopenArm(LOCAL_NAMESPACE); // the common #1601 local re-open in solo mode

    // NO synthetic frame: the verbatim stream is exactly the local source.
    expect(sink.text()).toBe(f1);
    expect(sink.text()).not.toContain("amicode.sync.gap");
    expect(sink.text()).not.toContain("local\u001f");
  });

  it("the INITIAL open (no prior delivery) does not emit a gap — only NON-initial re-opens do", () => {
    const sink = collectingSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    // Not calling reopenArm — the first openArm at start() must NOT gap.
    agg.ingest("studio", nsFrame("studio", 1));
    expect(sink.text()).not.toContain("amicode.sync.gap");
  });
});

describe("#1638 — resume() no-op WHEN ALREADY FLOWING (not when the sink is full); #1617 drain-flush preserved", () => {
  function controllableSink() {
    const chunks: string[] = [];
    let blocked = false;
    return {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return !blocked;
      },
      flush() {},
      block() {
        blocked = true;
      },
      unblock() {
        blocked = false;
      },
      text() {
        return chunks.join("");
      },
      count(ns: string) {
        return (this.text().match(new RegExp(`"ns":"${ns}"`, "g")) ?? []).length;
      },
    };
  }
  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("resume() while ALREADY FLOWING is a no-op: it does not re-flush or duplicate already-delivered frames", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);
    // never blocked → everything flows directly, flowing stays true
    agg.ingest("studio", nsFrame("studio", 1));
    agg.ingest("studio", nsFrame("studio", 2));
    const before = sink.text();
    agg.resume(); // already flowing → no-op
    agg.resume();
    expect(sink.text()).toBe(before); // no duplication, no extra writes
    expect(sink.count("studio")).toBe(2);
  });

  it("resume() on DRAIN still sets flowing=true and flushes the buffered idle frame (#1617 unchanged)", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect(); // fleet-of-one verbatim path
    const f1 = frame("event: message", 'data: {"big":"tool-output"}', "id: 7");
    const f2 = frame("event: session.status", 'data: {"status":"idle"}', "id: 8"); // the rail-clearing idle frame
    sink.block();
    agg.ingest(LOCAL_NAMESPACE, f1); // trip-frame, flowing→false
    agg.ingest(LOCAL_NAMESPACE, f2); // stranded in the verbatim buffer
    expect(sink.text()).toBe(f1); // idle frame held
    // drain: resume() must re-arm flowing and flush the stranded idle frame
    sink.unblock();
    agg.resume();
    expect(sink.text()).toBe(f1 + f2); // #1617: the buffered idle frame flushed, byte-identical
  });
});

describe("#1638 — control/gap/focus writes are return-checked and drain in true arrival order", () => {
  function controllableSink() {
    const chunks: string[] = [];
    let blocked = false;
    return {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return !blocked;
      },
      flush() {},
      block() {
        blocked = true;
      },
      unblock() {
        blocked = false;
      },
      text() {
        return chunks.join("");
      },
    };
  }
  function nsFrame(ns: string, n: number): string {
    return frame("event: message", `data: {"ns":"${ns}","n":${n}}`, `id: ${n}`);
  }

  it("a control frame (gap) written DURING backpressure emerges AFTER the data frames that preceded it", () => {
    const sink = controllableSink();
    const agg = new SseFanInAggregator({ sink });
    agg.connect();
    agg.setMembership([{ machineId: "studio", reachable: true, token: "tok-studio" }]);

    sink.block();
    agg.ingest("studio", nsFrame("studio", 1)); // trip-frame: written, flowing→false
    agg.ingest("studio", nsFrame("studio", 2)); // buffered behind the trip-frame
    // a control frame arrives mid-backpressure — it MUST NOT jump ahead of the
    // buffered data frame, nor be swallowed into the full sink.
    agg.reopenArm("studio"); // emits a gap through the return-checked helper

    // while blocked, the gap must NOT have been fired into the full socket ahead
    // of the still-buffered data frame 2.
    const textBlocked = sink.text();
    const gapIdxBlocked = textBlocked.indexOf("amicode.sync.gap");
    const n2IdxBlocked = textBlocked.indexOf('"n":2');
    // data frame 2 is still buffered (not yet written); if the gap were written
    // now it would sit ahead of frame 2 — the bug. Assert frame 2 hasn't shipped.
    expect(n2IdxBlocked).toBe(-1);

    sink.unblock();
    agg.resume();

    const text = sink.text();
    // ARRIVAL ORDER on drain: data frame 2 (buffered first) precedes the gap.
    const n2Idx = text.indexOf('"n":2');
    const gapIdx = text.indexOf("amicode.sync.gap");
    expect(n2Idx).toBeGreaterThanOrEqual(0);
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    expect(n2Idx).toBeLessThan(gapIdx); // control frame AFTER the preceding data frame
  });
});
