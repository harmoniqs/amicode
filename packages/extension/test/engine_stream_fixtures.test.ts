// engine_stream_fixtures.test.ts — #1771: the engine-shaped global-stream
// fixtures (test/fixtures/engine_stream) are SHARED test surface — the fan-in
// suites use them, and the loud-gap (#1773) and linear-splitting (#1779) slices
// build on them. This pins them to the wire the engine's `/global/event` route
// actually writes (overlay handlers/global.ts + bus/global.ts + the event-v2
// bridge), so a fixture can never drift into a frame production never sends.
import { describe, it, expect } from "vitest";
import {
  fakeEngine,
  engineFrame,
  busEvent,
  syncCopyOf,
  sequencedEvent,
  legacyEvent,
  largeSummaryFrame,
  chunkBytes,
  CHUNK_64K,
  TEN_MB,
  LOCAL_EPOCH,
  ENGINE_DIRECTORY,
} from "./fixtures/engine_stream/engine_frames";

/** Split one SSE frame into its field lines (the trailing blank line dropped). */
function fields(frame: string): Array<[string, string]> {
  expect(frame.endsWith("\n\n")).toBe(true);
  return frame
    .slice(0, -2)
    .split("\n")
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).replace(/^ /, "")] as [string, string];
    });
}
const idOf = (frame: string) => fields(frame).find(([k]) => k === "id")?.[1];
const dataOf = (frame: string) => JSON.parse(fields(frame).find(([k]) => k === "data")![1]);

describe("#1771 — engine-shaped fixtures match the engine's global-stream wire", () => {
  it("a frame is the SSE encoder's: optional `id:`, NO `event:` line (the name is \"message\"), one `data:` line, blank-line terminated", () => {
    const f = engineFrame(busEvent({ id: "evt_1", type: "session.status", properties: { a: 1 } }), { id: `${LOCAL_EPOCH}:3` });
    expect(fields(f).map(([k]) => k)).toEqual(["id", "data"]);
    expect(f).not.toContain("event:");
    // JSON.stringify(event) — the bridge's key order, payload {id, type, properties}
    expect(fields(f)[1][1]).toBe(
      `{"directory":"${ENGINE_DIRECTORY}","project":"prj_0fixture","payload":{"id":"evt_1","type":"session.status","properties":{"a":1}}}`,
    );
  });

  it("LEGACY (pre-#1776) engine: every frame is id-less — events, twins, heartbeats, connected", () => {
    const e = fakeEngine({ legacy: true });
    const frames = [e.connected(), e.event("session.status", { s: 1 }), ...e.stored("message.updated", { m: 1 }, { aggregateID: "ses_1" }), e.heartbeat()];
    for (const f of frames) {
      expect(idOf(f)).toBeUndefined();
      expect(fields(f).map(([k]) => k)).toEqual(["data"]);
    }
    expect(dataOf(frames.at(-1)!).payload).toMatchObject({ type: "server.heartbeat", properties: {} });
    expect(legacyEvent({ x: 1 })).not.toContain("id:");
  });

  it("SEQUENCED (#1776) engine: bus events take strictly increasing `<epoch>:<seq>`; control frames carry the CURRENT seq and consume none", () => {
    let now = 1_700_000_000_000;
    const e = fakeEngine({ epoch: LOCAL_EPOCH, now: () => now });
    const connected = e.connected();
    const a = e.event("session.status", { s: 1 });
    now += 10_000;
    const hb = e.heartbeat();
    const b = e.event("session.status", { s: 2 });
    expect([idOf(connected), idOf(a), idOf(hb), idOf(b)]).toEqual([`${LOCAL_EPOCH}:0`, `${LOCAL_EPOCH}:1`, `${LOCAL_EPOCH}:1`, `${LOCAL_EPOCH}:2`]);
    expect(dataOf(hb).payload).toMatchObject({ type: "server.heartbeat", properties: { time: 1_700_000_010_000, seq: 1 } });
    expect(dataOf(connected).payload).toMatchObject({ type: "server.connected", properties: {} });
    expect(e.seq).toBe(2);
    expect(sequencedEvent(LOCAL_EPOCH, 9, { n: 9 })).toMatch(new RegExp(`^id: ${LOCAL_EPOCH}:9\\n`));
  });

  it("a stored event is the plain + sync TWIN: the copy mirrors its source and shares its id (one seq)", () => {
    const e = fakeEngine({ epoch: LOCAL_EPOCH });
    const [plain, sync] = e.stored("message.part.updated", { part: { id: "prt_1" } }, { aggregateID: "ses_9", durableSeq: 41 });
    expect(idOf(plain)).toBe(`${LOCAL_EPOCH}:1`);
    expect(idOf(sync)).toBe(idOf(plain)); // filtering sync copies leaves no hole
    const p = dataOf(plain);
    const s = dataOf(sync);
    expect(p.payload).toEqual({ id: p.payload.id, type: "message.part.updated", properties: { part: { id: "prt_1" } } });
    expect(s.directory).toBe(p.directory);
    expect(s.payload).toEqual({
      type: "sync",
      syncEvent: { id: p.payload.id, type: "message.part.updated.1", seq: 41, aggregateID: "ses_9", data: { part: { id: "prt_1" } } },
      id: p.payload.id,
    });
    // the bus assigns the copy's payload.id at emit → it serializes AFTER syncEvent
    expect(fields(sync)[1][1].indexOf('"syncEvent"')).toBeLessThan(fields(sync)[1][1].lastIndexOf('"id"'));
    expect(syncCopyOf(busEvent({ id: "evt_x", type: "t", properties: {} }), { seq: 1, aggregateID: "a" }).payload.type).toBe("sync");
    // on a legacy engine the twin is two id-less frames
    const [lp, ls] = fakeEngine({ legacy: true }).stored("message.updated", {}, { aggregateID: "ses_1" });
    expect([idOf(lp), idOf(ls)]).toEqual([undefined, undefined]);
  });

  it("the large frame: ≥ 10 MB of message.updated summary patch text, delivered in exact 64 KB byte chunks", () => {
    const big = largeSummaryFrame();
    const bytes = Buffer.byteLength(big);
    expect(bytes).toBeGreaterThanOrEqual(TEN_MB);
    expect(bytes).toBeLessThan(TEN_MB + 1024 * 1024);
    expect(big.length).toBeLessThan(bytes); // non-ASCII: bytes ≠ string length
    const data = dataOf(big);
    expect(data.payload.type).toBe("message.updated");
    expect(data.payload.properties.info.summary.diffs[0]).toEqual(
      expect.objectContaining({ file: expect.any(String), patch: expect.any(String), additions: 1400, deletions: 0, status: "modified" }),
    );
    expect(idOf(big)).toBeUndefined(); // legacy by default …
    expect(idOf(largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 7 }))).toBe(`${LOCAL_EPOCH}:7`); // … or sequenced

    const chunks = chunkBytes(big);
    expect(chunks.slice(0, -1).every((c) => c.length === CHUNK_64K)).toBe(true);
    expect(chunks.at(-1)!.length).toBeGreaterThan(0);
    expect(chunks.at(-1)!.length).toBeLessThanOrEqual(CHUNK_64K);
    expect(Buffer.concat(chunks).equals(Buffer.from(big, "utf8"))).toBe(true);
    // at least one boundary falls inside a multi-byte code point, as on the wire
    expect(chunks.some((c) => (c[0] & 0xc0) === 0x80)).toBe(true);
  });
});
