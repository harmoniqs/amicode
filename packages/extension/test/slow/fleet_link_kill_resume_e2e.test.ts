import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SseFanInDriver } from "../../src/amicode_service/sse_fanin_driver";
import { SessionOwnerMap } from "../../src/amicode_service/session_multiplexer";
import { FanInCensus } from "../../src/amicode_service/fanin_census";
import { parseCompositeCursor } from "../../src/amicode_service/sse_composite_cursor";
// The CLIENT's own resume cursor + contiguity check (the app overlay's pure
// module the webview's stream loop runs) — the observer applies every frame
// through it, exactly as the app does.
import { createStreamCursor } from "../../../app-bundle/overlay/packages/app/src/context/stream-cursor";

// ============================================================================
// #1777 AC6 — TWO-PEER FLEET E2E WITH A LINK KILL, against two REAL compiled
// engines (the #1776 sequenced, replaying global stream).
//
//   engine A (:4191) ── the observer's local engine ──────────┐
//   engine B (:4192) ── the owner peer ── link (:4193, TCP) ──┤ fan-in (in-test,
//                                                            │ SseFanInDriver +
//                     observer (SSE client, the app's        │ the real reader)
//                     stream-cursor) ◀── /global/event ──────┘
//
// A turn runs on B (a shell tool streaming output: user message, assistant
// message, a running tool part updated per chunk, completion). MID-TURN the
// link is KILLED — every proxied socket destroyed and the port closed (a dead
// SSH forward: connection refused) — and later RESTORED. The fan-in's peer arm
// fails, its re-opens are refused while the link is down, then one resumes from
// the last delivered engine id and B replays what the observer missed. After
// the turn the observer's transcript must equal a fresh load from B, with no
// gap frame and no resync owed (no hole, no reset).
//
// Opt-in: SCRATCH_ENGINE_E2E=1, after `pnpm --filter amicode run build:binary`
// (not an AMICODE_* name: test/setup_hermetic_env.ts deletes those before this
// module's gate is read). Both engines run the vendored binary of THIS checkout
// on spare ports in 4190–4199 (never a hub port), each with every state dir and
// its session DB in its own temp dir, and are killed afterwards. Live hubs and
// the live peer link are never touched.
// ============================================================================

const ENABLED = process.env.SCRATCH_ENGINE_E2E === "1";
const BIN =
  process.env.SCRATCH_ENGINE_BIN ?? join(__dirname, "..", "..", "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
const PORT_A = Number(process.env.SCRATCH_ENGINE_PORT_A ?? 4191);
const PORT_B = Number(process.env.SCRATCH_ENGINE_PORT_B ?? 4192);
const PORT_LINK = Number(process.env.SCRATCH_LINK_PORT ?? 4193);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Engine {
  proc: ChildProcess;
  dir: string;
  url: string;
  log(): string;
}

async function startEngine(port: number, name: string): Promise<Engine> {
  if (!(port >= 4190 && port <= 4199)) throw new Error(`scratch port ${port} outside 4190-4199`);
  const dir = mkdtempSync(join(tmpdir(), `amicode-scratch-${name}-`));
  const proj = join(dir, "proj");
  mkdirSync(proj);
  mkdirSync(join(dir, "home"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENCODE|AMICO)/.test(k)) env[k] = v;
  Object.assign(env, {
    HOME: join(dir, "home"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_CACHE_HOME: join(dir, "cache"),
    OPENCODE_DB: join(dir, "db.sqlite"),
  });
  let log = "";
  const proc = spawn(BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO", "--pure"], {
    cwd: proj,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => (log += d));
  proc.stderr?.on("data", (d: Buffer) => (log += d));
  await until(() => log.includes(`listening on http://127.0.0.1:${port}`) || proc.exitCode !== null || undefined, `engine ${name} listen`, 60_000);
  if (proc.exitCode !== null) throw new Error(`engine ${name} exited early:\n${log}`);
  return { proc, dir, url: `http://127.0.0.1:${port}`, log: () => log };
}

async function stopEngine(e: Engine | undefined): Promise<void> {
  if (!e) return;
  e.proc.kill("SIGTERM");
  for (let i = 0; i < 40 && e.proc.exitCode === null && e.proc.signalCode === null; i++) await sleep(50);
  if (e.proc.exitCode === null && e.proc.signalCode === null) e.proc.kill("SIGKILL");
  rmSync(e.dir, { recursive: true, force: true });
}

/** The peer link: a TCP forward 127.0.0.1:PORT_LINK → engine B. `kill()` is a
 *  dead SSH forward — every proxied socket destroyed, the port closed
 *  (connection refused); `restore()` listens again. */
function peerLink(target: number) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let accepted = 0;
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server = net.createServer((client) => {
        accepted += 1;
        const upstream = net.connect(target, "127.0.0.1");
        sockets.add(client);
        sockets.add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.once("error", reject);
      server.listen(PORT_LINK, "127.0.0.1", () => resolve());
    });
  return {
    url: `http://127.0.0.1:${PORT_LINK}`,
    restore: listen,
    kill: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        if (!server) return resolve();
        server.close(() => resolve());
        server = undefined;
      }),
    accepted: () => accepted,
  };
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ── the transcript a viewer holds: messages and parts of ONE session ────────

type Json = Record<string, any>;
type Transcript = Map<string, { info?: Json; parts: Map<string, Json> }>;

function applyEvent(t: Transcript, sessionID: string, type: string, p: Json): void {
  const msg = (id: string) => {
    let m = t.get(id);
    if (!m) t.set(id, (m = { parts: new Map() }));
    return m;
  };
  if (type === "message.updated" && p.info?.sessionID === sessionID) msg(p.info.id).info = p.info;
  else if (type === "message.removed" && p.sessionID === sessionID) t.delete(p.messageID);
  else if (type === "message.part.updated" && p.part?.sessionID === sessionID) msg(p.part.messageID).parts.set(p.part.id, p.part);
  else if (type === "message.part.removed" && p.sessionID === sessionID) t.get(p.messageID)?.parts.delete(p.partID);
  else if (type === "message.part.delta" && p.sessionID === sessionID) {
    const part = t.get(p.messageID)?.parts.get(p.partID);
    if (part) part[p.field] = String(part[p.field] ?? "") + p.delta;
  }
}

/** A comparable transcript. The wire drops summary patch bodies (#1778 — the
 *  stored record keeps them), so they are dropped from both sides. */
function canonical(messages: Array<{ info?: Json; parts: Json[] }>): unknown {
  const strip = (info: Json | undefined) => {
    if (!info?.summary?.diffs) return info;
    return { ...info, summary: { ...info.summary, diffs: info.summary.diffs.map(({ patch: _p, ...rest }: Json) => rest) } };
  };
  return [...messages]
    .sort((a, b) => String(a.info?.id).localeCompare(String(b.info?.id)))
    .map((m) => ({ info: strip(m.info), parts: [...m.parts].sort((a, b) => String(a.id).localeCompare(String(b.id))) }));
}

describe.skipIf(!ENABLED)("#1777 AC6 — two-peer fleet E2E: a link kill mid-turn loses nothing (two scratch engines)", () => {
  let a: Engine | undefined;
  let b: Engine | undefined;

  beforeAll(async () => {
    if (!existsSync(BIN)) throw new Error(`no compiled engine at ${BIN} — run build:binary first`);
    if (!(PORT_LINK >= 4190 && PORT_LINK <= 4199)) throw new Error(`link port ${PORT_LINK} outside 4190-4199`);
    [a, b] = await Promise.all([startEngine(PORT_A, "a"), startEngine(PORT_B, "b")]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([stopEngine(a), stopEngine(b)]);
  });

  it("killing the peer link mid-turn and restoring it leaves the observer's transcript identical to a fresh load", async () => {
    const link = peerLink(PORT_B);
    await link.restore();
    const ownerMap = new SessionOwnerMap();
    const census: string[] = [];
    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "observer",
      localEventUrl: () => a!.url,
      peerBaseUrl: (id) => (id === "studio" ? link.url : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: link.url, token: "scratch-peer-token" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 200, // the production cadence drives every re-open
      census: new FanInCensus({ plane: "observe", sink: (l) => census.push(l) }),
    });
    const front = http.createServer((req, res) => void driver.handle(req, res));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const frontUrl = `http://127.0.0.1:${(front.address() as net.AddressInfo).port}`;

    // ── the observer: the app's cursor applied to every frame ────────────────
    const cursor = createStreamCursor();
    const transcript: Transcript = new Map();
    const seen: Array<{ id?: string; type?: string }> = [];
    const resyncs: unknown[] = [];
    const gaps: unknown[] = [];
    let duplicates = 0;
    let sessionID = "";
    const pendingBeforeSession: Array<{ type: string; p: Json }> = [];
    let buffer = "";
    const observer = http.get(`${frontUrl}/global/event`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(5).trim()) as Json;
          const type: string = data.payload?.type ?? data.type;
          seen.push({ id, type });
          if (type === "amicode.sync.gap") {
            gaps.push(data);
            cursor.gap(data.namespaces ?? []);
            continue;
          }
          const verdict = cursor.frame({ id, type });
          if (verdict.resync) resyncs.push(verdict.resync);
          if (!verdict.apply) {
            duplicates += 1;
            continue;
          }
          const props = (data.payload?.properties ?? {}) as Json;
          if (sessionID) applyEvent(transcript, sessionID, type, props);
          else pendingBeforeSession.push({ type, p: props });
        }
      });
      res.on("error", () => undefined);
    });
    observer.on("error", () => undefined);

    try {
      await until(() => seen.some((f) => f.type === "server.connected"), "the observer's stream");

      // a session on the PEER, owned by it; the fan-in opens the peer arm
      const session = (await post(`${b!.url}/session`, {})) as { id: string };
      sessionID = session.id;
      for (const e of pendingBeforeSession) applyEvent(transcript, sessionID, e.type, e.p);
      ownerMap.update([{ id: sessionID, amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } }]);
      await until(() => seen.some((f) => f.type === "server.connected" && parseCompositeCursor(f.id).has("studio")), "the peer arm");

      // ── the turn: a shell tool streaming output for ~3 s ────────────────────
      const ticks = Array.from({ length: 30 }, (_, i) => `t${i}`).join(" ");
      const turn = post(`${b!.url}/session/${sessionID}/shell`, {
        agent: "build",
        model: { providerID: "scratch", modelID: "scratch" },
        command: `for x in ${ticks}; do echo tick; sleep 0.1; done`,
      });
      const runningPart = () =>
        [...transcript.values()].flatMap((m) => [...m.parts.values()]).find((p) => p.type === "tool" && p.state?.status === "running" && String(p.state?.metadata?.output ?? "").includes("tick"));
      await until(() => runningPart(), "the running tool part with output");

      // ── KILL the link mid-turn ──────────────────────────────────────────────
      const killedAt = seen.length;
      await link.kill();
      await until(() => census.some((l) => l.includes("arm-closed") && l.includes("arm=studio") && l.includes("reason=upstream-")), "the peer arm to fail");
      await sleep(800); // the turn goes on while the link is down; re-opens are refused
      const framesWhileDown = seen.length - killedAt;
      const reopensRefused = census.filter((l) => l.includes("arm=studio") && l.includes("arm-closed")).length;
      expect(runningPart()).toBeDefined(); // still mid-turn: the completion has not reached the observer

      // ── RESTORE it ──────────────────────────────────────────────────────────
      await link.restore();
      await turn; // the turn completes on the peer
      // the observer converges on the fresh load (it keeps streaming; poll the owner)
      const freshLoad = async () => canonical((await (await fetch(`${b!.url}/session/${sessionID}/message`)).json()) as Array<{ info: Json; parts: Json[] }>);
      const observed = () => canonical([...transcript.values()].map((m) => ({ info: m.info, parts: [...m.parts.values()] })));
      let fresh: unknown = await freshLoad();
      const deadline = Date.now() + 15_000;
      while (JSON.stringify(observed()) !== JSON.stringify(fresh) && Date.now() < deadline) {
        await sleep(100);
        fresh = await freshLoad();
      }

      // the replay that recovered it, as the peer engine logged it
      const replayLines = b!.log().split("\n").filter((l) => l.includes("global event connected") && l.includes("resume=replay"));
      const replayed = replayLines.map((l) => Number(/replayed=(\d+)/.exec(l)?.[1] ?? 0));
      console.log(
        "[#1777 AC6]",
        JSON.stringify({
          observerFrames: seen.length,
          framesWhileDown,
          studioArmClosesWhileDown: reopensRefused,
          linkConnections: link.accepted(),
          peerReplays: replayed,
          gaps: gaps.length,
          resyncs,
          duplicatesDropped: duplicates,
          transcriptMessages: transcript.size,
          cursor: cursor.current(),
        }),
      );

      expect(observed()).toEqual(fresh); // identical to a fresh load
      const parts = [...transcript.values()].flatMap((m) => [...m.parts.values()]);
      expect(parts.find((p) => p.type === "tool")?.state?.status).toBe("completed");
      expect(gaps).toEqual([]); // no gap signal …
      expect(resyncs).toEqual([]); // … and no hole or reset: nothing needed a resync
      expect(census.some((l) => l.includes("gap-emitted"))).toBe(false);
      expect(replayed.some((n) => n > 0)).toBe(true); // the peer REPLAYED the missed stretch
      expect(parseCompositeCursor(cursor.current()).get("studio")).toMatch(/^[A-Za-z0-9_-]+:\d+$/); // the observer's cursor holds the peer's engine id
    } finally {
      observer.destroy();
      front.closeAllConnections?.();
      await new Promise<void>((r) => front.close(() => r()));
      await link.kill();
    }
  }, 90_000);
});
