// ============================================================================
// #1771 — ENGINE-SHAPED global-stream fixtures (shared test surface; #1773 and
// #1779 build on these).
//
// The fan-in suites used to feed synthetic `event: message` / `id: 1` frames —
// a wire the engine never sends. These builders produce the frames the engine's
// `/global/event` route ACTUALLY writes, so the suites exercise production's
// wire format:
//
//   - The route serializes each global event once with `JSON.stringify(event)`
//     (`{directory, project, workspace?, payload}`, payload `{id, type,
//     properties}`) and writes it through effect's SSE encoder: an `id:` line
//     when the event has one, NO `event:` line (the event name is "message",
//     which the encoder omits), one `data:` line, then the blank line.
//   - LEGACY (pre-#1776) engines send NO `id:` line at all — every frame is
//     id-less. This is what a peer running an old engine sends (#1773 needs it).
//   - SEQUENCED (#1776) engines stamp `id: <epoch>:<seq>`. Bus events take a
//     strictly increasing seq; the per-connection control frames
//     (`server.connected`, `server.heartbeat`) consume NO seq and carry the
//     CURRENT one, so ids on one connection never decrease.
//   - A stored (durable) event is emitted TWICE by the event-v2 bridge: the
//     plain event, then its `sync` copy (`payload.type === "sync"`, the source
//     under `syncEvent`). The copy shares its source's seq, so on a sequenced
//     engine both frames carry the SAME id.
//   - A per-turn summary (`message.updated` with `info.summary.diffs[].patch`)
//     can be ~10 MB in ONE frame (measured 12.3 MB on the Studio), which the
//     network delivers in 64 KB chunks.
//
// Pure builders + one stateful `fakeEngine` that sequences like the engine.
// Deterministic by construction: no clock or randomness unless injected.
// ============================================================================
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** A representative engine process epoch (`randomBytes(6).toString("base64url")`). */
export const LOCAL_EPOCH = "bG9jYWwx";
/** A second process epoch — a peer's engine. */
export const PEER_EPOCH = "c3R1ZGlv";

export const ENGINE_DIRECTORY = "/Users/jj/harmoniqs/amicode";
export const ENGINE_PROJECT = "prj_0fixture";

/** The payload of one global event (what the engine's bus carries). */
export interface EnginePayload {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  syncEvent?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One global event as the engine serializes it (`JSON.stringify(event)`). */
export interface EngineGlobalEvent {
  directory?: string;
  project?: string;
  workspace?: string;
  payload: EnginePayload;
}

/** The #1776 global-stream frame id: `<epoch>:<seq>`. */
export function engineId(epoch: string, seq: number): string {
  return `${epoch}:${seq}`;
}

/** Serialize one global event as the engine's SSE encoder writes it: an `id:`
 *  line only when `id` is given (sequenced engines), no `event:` line, one
 *  `data:` line, the blank-line terminator. */
export function engineFrame(event: EngineGlobalEvent, opts: { id?: string } = {}): string {
  const idLine = opts.id !== undefined ? `id: ${opts.id}\n` : "";
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}

/** A bus event as the event-v2 bridge emits it (`{directory, project,
 *  workspace?, payload: {id, type, properties}}` — key order preserved). */
export function busEvent(opts: {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
  project?: string;
  workspace?: string;
}): EngineGlobalEvent {
  return {
    directory: opts.directory ?? ENGINE_DIRECTORY,
    project: opts.project ?? ENGINE_PROJECT,
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    payload: { id: opts.id, type: opts.type, properties: opts.properties },
  };
}

/** The `sync` copy the bridge emits right after a durable event. The bus
 *  assigns the copy's `payload.id` from `syncEvent.id` at emit (so the key lands
 *  AFTER `syncEvent`, exactly as the engine serializes it). */
export function syncCopyOf(
  source: EngineGlobalEvent,
  durable: { seq: number; aggregateID: string; version?: number },
): EngineGlobalEvent {
  const id = source.payload.id;
  return {
    ...(source.directory !== undefined ? { directory: source.directory } : {}),
    ...(source.project !== undefined ? { project: source.project } : {}),
    ...(source.workspace !== undefined ? { workspace: source.workspace } : {}),
    payload: {
      type: "sync",
      syncEvent: {
        id,
        type: `${source.payload.type}.${durable.version ?? 1}`,
        seq: durable.seq,
        aggregateID: durable.aggregateID,
        data: source.payload.properties ?? {},
      },
      id,
    },
  };
}

/** A per-connection control event (`server.connected` / `server.heartbeat` /
 *  `server.cursor.unservable`): payload only, no directory. */
export function controlEvent(id: string, type: string, properties: Record<string, unknown> = {}): EngineGlobalEvent {
  return { payload: { id, type, properties } };
}

// ── a stateful engine that sequences like the real one ──────────────────────

export interface FakeEngine {
  /** The process epoch, or undefined for a LEGACY (id-less) engine. */
  readonly epoch: string | undefined;
  /** The current sequence (the last bus event's), 0 before any. */
  readonly seq: number;
  /** The SSE id a sequenced engine stamps for `seq`; undefined when legacy. */
  idAt(seq: number): string | undefined;
  /** The `server.connected` frame (first frame of every connection). */
  connected(): string;
  /** A heartbeat frame (legacy: empty properties; sequenced: `{time, seq}`). */
  heartbeat(): string;
  /** One non-durable bus event frame (consumes one seq). */
  event(type: string, properties: Record<string, unknown>): string;
  /** A stored (durable) event: the plain frame then its `sync` twin — one seq,
   *  shared (on a sequenced engine both frames carry the same id). */
  stored(type: string, properties: Record<string, unknown>, durable: { aggregateID: string; durableSeq?: number }): [plain: string, sync: string];
}

/** An engine stream: `{ legacy: true }` (pre-#1776, NO `id:` lines) or
 *  `{ epoch }` (#1776, `id: <epoch>:<seq>`). `now` stamps heartbeat time. */
export function fakeEngine(
  opts: { legacy: true; now?: () => number; directory?: string } | { epoch: string; now?: () => number; directory?: string },
): FakeEngine {
  const epoch = "epoch" in opts ? opts.epoch : undefined;
  const now = opts.now ?? (() => 0);
  const directory = opts.directory ?? ENGINE_DIRECTORY;
  let seq = 0;
  let evt = 0;
  const nextPayloadId = (): string => `evt_${String(++evt).padStart(6, "0")}`;
  const idAt = (s: number): string | undefined => (epoch === undefined ? undefined : engineId(epoch, s));
  const frame = (event: EngineGlobalEvent, s: number): string => {
    const id = idAt(s);
    return engineFrame(event, id !== undefined ? { id } : {});
  };
  let durableSeq = 0;
  return {
    epoch,
    get seq() {
      return seq;
    },
    idAt,
    connected: () => frame(controlEvent(nextPayloadId(), "server.connected"), seq),
    heartbeat: () =>
      frame(controlEvent(nextPayloadId(), "server.heartbeat", epoch === undefined ? {} : { time: now(), seq }), seq),
    event: (type, properties) => {
      const s = ++seq;
      return frame(busEvent({ id: nextPayloadId(), type, properties, directory }), s);
    },
    stored: (type, properties, durable) => {
      const s = ++seq;
      const source = busEvent({ id: nextPayloadId(), type, properties, directory });
      const twin = syncCopyOf(source, { seq: durable.durableSeq ?? ++durableSeq, aggregateID: durable.aggregateID });
      return [frame(source, s), frame(twin, s)];
    },
  };
}

// ── #1777: an engine that REPLAYS (the #1776 subscribe contract) ────────────

/** One subscription to a replaying engine's `/global/event`: the arm source the
 *  fan-in pumps, plus the test's handle to end it (a link drop, an engine exit). */
export interface EngineSubscription {
  /** The cursor this subscription asked for (`undefined` = live only). */
  readonly cursor: string | undefined;
  /** Whether the engine answered the cursor with a reset. */
  readonly reset: boolean;
  source: {
    next(): Promise<string | null>;
    close(): void;
    endReason(): "end" | "error" | undefined;
  };
  /** End the subscription: `"end"` = a clean upstream end, `"error"` = a failure. */
  end(why?: "end" | "error"): void;
}

export interface ReplayingEngine {
  /** The process epoch. */
  readonly epoch: string;
  /** The current sequence (the last bus event's), 0 before any. */
  readonly seq: number;
  /** The SSE id this engine stamps for `seq`. */
  idAt(seq: number): string;
  /** Emit one bus event: framed ONCE (`id: <epoch>:<seq>`), retained for replay,
   *  and delivered to every open subscription. Returns the frame. */
  publish(type: string, properties: Record<string, unknown>): string;
  /** A heartbeat on every open subscription (`{time, seq}`, the CURRENT seq). */
  heartbeat(): void;
  /** Subscribe like `GET /global/event[?lastEventID=…]`: a servable cursor gets
   *  `server.connected` AT the cursor, then every retained frame after it, then
   *  live frames; an unservable one (wrong epoch, evicted, ahead, malformed) gets
   *  the `server.cursor.unservable` reset frame first, then `server.connected` at
   *  the current seq, then live. No cursor = `server.connected` + live. */
  subscribe(cursor?: string): EngineSubscription;
  /** Drop retained frames at or below `seq` (the replay window moved past them). */
  evictThrough(seq: number): void;
  /** Every subscription opened so far, in order. */
  readonly subscriptions: readonly EngineSubscription[];
  /** The subscriptions still open. */
  live(): EngineSubscription[];
}

/** A #1776 engine with a replay buffer, in-process: the fan-in suites drive a
 *  re-open against it and see exactly what a real engine would send. */
export function replayingEngine(opts: { epoch: string; now?: () => number; directory?: string }): ReplayingEngine {
  const epoch = opts.epoch;
  const now = opts.now ?? (() => 0);
  const directory = opts.directory ?? ENGINE_DIRECTORY;
  let seq = 0;
  let floor = 0; // the highest seq no longer retained
  let evt = 0;
  const retained: Array<{ seq: number; frame: string }> = [];
  const subscriptions: Array<EngineSubscription & { push(frame: string): void; open: boolean }> = [];
  const nextPayloadId = (): string => `evt_${epoch}_${String(++evt).padStart(6, "0")}`;
  const control = (at: number, type: string, properties: Record<string, unknown> = {}): string =>
    engineFrame(controlEvent(nextPayloadId(), type, properties), { id: engineId(epoch, at) });

  const open = (cursor: string | undefined) => {
    const queue: string[] = [];
    const waiters: Array<(v: string | null) => void> = [];
    let ended = false;
    let reason: "end" | "error" | undefined;
    const end = (why: "end" | "error" = "end"): void => {
      if (ended) return;
      ended = true;
      reason = why;
      sub.open = false;
      let w: ((v: string | null) => void) | undefined;
      while ((w = waiters.shift())) w(null);
    };
    const push = (frame: string): void => {
      if (ended) return;
      const w = waiters.shift();
      if (w) w(frame);
      else queue.push(frame);
    };
    const parsed = cursor === undefined ? undefined : /^([A-Za-z0-9_-]+):(\d+)$/.exec(cursor.trim());
    const servable =
      cursor === undefined ||
      (parsed !== null && parsed !== undefined && parsed[1] === epoch && Number(parsed[2]) <= seq && Number(parsed[2]) >= floor);
    const position = cursor !== undefined && servable && parsed ? Number(parsed[2]) : seq;
    const sub = {
      cursor,
      reset: !servable,
      open: true,
      push,
      end,
      source: {
        next(): Promise<string | null> {
          const f = queue.shift();
          if (f !== undefined) return Promise.resolve(f);
          if (ended) return Promise.resolve(null);
          return new Promise<string | null>((resolve) => waiters.push(resolve));
        },
        close: () => end("end"),
        endReason: () => reason,
      },
    };
    if (!servable) push(control(seq, "server.cursor.unservable", { epoch, seq }));
    push(control(position, "server.connected"));
    if (servable) for (const r of retained) if (r.seq > position) push(r.frame);
    subscriptions.push(sub);
    return sub;
  };

  return {
    epoch,
    get seq() {
      return seq;
    },
    idAt: (s) => engineId(epoch, s),
    publish(type, properties) {
      const s = ++seq;
      const frame = engineFrame(busEvent({ id: nextPayloadId(), type, properties, directory }), { id: engineId(epoch, s) });
      retained.push({ seq: s, frame });
      for (const sub of subscriptions) if (sub.open) sub.push(frame);
      return frame;
    },
    heartbeat() {
      for (const sub of subscriptions) if (sub.open) sub.push(control(seq, "server.heartbeat", { time: now(), seq }));
    },
    subscribe: (cursor) => open(cursor),
    evictThrough(s) {
      while (retained.length > 0 && retained[0].seq <= s) retained.shift();
      floor = Math.max(floor, s);
    },
    get subscriptions() {
      return subscriptions;
    },
    live: () => subscriptions.filter((s) => s.open),
  };
}

/** A one-off sequenced bus-event frame at an explicit `seq` — for suites that
 *  script many namespaces' positions directly. `properties` ride verbatim. */
export function sequencedEvent(epoch: string, seq: number, properties: Record<string, unknown>, type = "message.part.updated"): string {
  return engineFrame(busEvent({ id: `evt_${epoch}_${seq}`, type, properties }), { id: engineId(epoch, seq) });
}

/** A one-off LEGACY (id-less) bus-event frame. */
export function legacyEvent(properties: Record<string, unknown>, type = "message.part.updated", payloadId = "evt_legacy"): string {
  return engineFrame(busEvent({ id: payloadId, type, properties }));
}

// ── the large frame + its chunked delivery ──────────────────────────────────

export const TEN_MB = 10 * 1024 * 1024;
export const CHUNK_64K = 64 * 1024;

/** A `message.updated` frame whose `info.summary.diffs[].patch` text brings the
 *  frame to at least `targetBytes` UTF-8 bytes (default 10 MB) — the shape of
 *  the measured multi-MB summary events. The patch text carries non-ASCII
 *  characters, so bytes ≠ string length and a 64 KB byte-chunk boundary can
 *  fall inside a code point (as it does on the wire). */
export function largeSummaryFrame(opts: { targetBytes?: number; epoch?: string; seq?: number } = {}): string {
  const target = opts.targetBytes ?? TEN_MB;
  const lines: string[] = [];
  for (let i = 0; i < 1400; i++) lines.push(`+  const row${i} = "résumé → ${"x".repeat(60)}";`);
  const patch = `@@ -1,0 +1,1400 @@\n${lines.join("\n")}\n`;
  // one diff entry's serialized size (patch JSON-escapes its newlines)
  const perDiff = Buffer.byteLength(JSON.stringify(patch)) + 96;
  const count = Math.max(1, Math.ceil(target / perDiff));
  const diffs = Array.from({ length: count }, (_, i) => ({
    file: `src/module_${i}.ts`,
    patch,
    additions: 1400,
    deletions: 0,
    status: "modified",
  }));
  const event = busEvent({
    id: "evt_summary",
    type: "message.updated",
    properties: { info: { id: "msg_summary", sessionID: "ses_large", role: "user", summary: { diffs } } },
  });
  const id = opts.epoch !== undefined ? engineId(opts.epoch, opts.seq ?? 1) : undefined;
  return engineFrame(event, id !== undefined ? { id } : {});
}

/** Split text's UTF-8 BYTES into `chunkSize` pieces (the last may be short) —
 *  how the network delivers a large frame. Concatenating the chunks yields the
 *  exact original bytes. */
export function chunkBytes(text: string, chunkSize = CHUNK_64K): Buffer[] {
  const bytes = Buffer.from(text, "utf8");
  const out: Buffer[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) out.push(bytes.subarray(off, off + chunkSize));
  return out;
}

// ── a scripted engine `/global/event` server (127.0.0.1, port 0) ────────────

export interface EngineSseServer {
  /** `http://127.0.0.1:<port>` — dial THIS address (never a wildcard bind). */
  url: string;
  /** Every request's path + query, in arrival order. */
  requests: string[];
  stop(): Promise<void>;
}

/** Serve `/global/event` from a script: `script(res)` writes the stream (whole
 *  frames, or raw chunks) and decides how it ends (`res.end()` = a clean
 *  upstream end; `res.destroy()` = an upstream error). Bound to 127.0.0.1 on an
 *  ephemeral port and dialed at its own address, so no foreign listener can
 *  share it. #1773: `opts.status` answers a non-200 instead (an auth failure, an
 *  overloaded peer) with a JSON content type; the script writes its body. */
export function startEngineSseServer(
  script: (res: http.ServerResponse, req: http.IncomingMessage) => void | Promise<void>,
  opts: { status?: number } = {},
): Promise<EngineSseServer> {
  const requests: string[] = [];
  const status = opts.status ?? 200;
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "/");
    res.writeHead(
      status,
      status === 200
        ? { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" }
        : { "content-type": "application/json" },
    );
    res.flushHeaders();
    void script(res, req);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** Write chunks one at a time, honoring backpressure (wait for `drain`). */
export async function writeChunks(res: http.ServerResponse, chunks: Buffer[]): Promise<void> {
  for (const c of chunks) {
    if (!res.write(c)) await new Promise<void>((r) => res.once("drain", () => r()));
  }
}
