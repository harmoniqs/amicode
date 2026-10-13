import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Scratch-engine check of the sequenced, replayable global stream (#1776),
// against the COMPILED engine binary — the runtime (Bun's node:http shim)
// whose client-abort behaviour the in-process suite cannot vouch for alone.
//
// Opt-in: SCRATCH_ENGINE_E2E=1, after `pnpm --filter amicode run build:binary`
// (not an AMICODE_* name: test/setup_hermetic_env.ts deletes those before this
// module's gate is read). It spawns the vendored binary of THIS checkout on a spare port
// (default 4195; never a hub port) with every state dir and the session DB in
// one temp dir, and kills it afterwards (SCRATCH_ENGINE_BIN points it at another
// binary, e.g. a baseline build). Live hubs are never touched.
// ============================================================================

const ENABLED = process.env.SCRATCH_ENGINE_E2E === "1";
const BIN =
  process.env.SCRATCH_ENGINE_BIN ?? join(__dirname, "..", "..", "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
const PORT = Number(process.env.SCRATCH_ENGINE_PORT ?? 4195);
const ID = /^([A-Za-z0-9_-]+):(\d+)$/;

type Frame = { id: string; type: string; data: string };

function seqOf(frame: Frame) {
  const match = ID.exec(frame.id);
  if (!match) throw new Error(`frame id ${JSON.stringify(frame.id)} is not <epoch>:<seq>`);
  return { epoch: match[1], seq: Number(match[2]) };
}

function stream(headers: Record<string, string> = {}) {
  const frames: Frame[] = [];
  let buffer = "";
  let req!: http.ClientRequest;
  const opened = new Promise<void>((resolve, reject) => {
    req = http.get({ host: "127.0.0.1", port: PORT, path: "/global/event", headers: { accept: "text/event-stream", ...headers } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) frames.push({ id, data, type: JSON.parse(data).payload?.type });
          end = buffer.indexOf("\n\n");
        }
      });
      res.on("error", () => {});
      resolve();
    });
    req.on("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNRESET" ? undefined : reject(e)));
  });
  return { frames, opened, abort: () => req.destroy() };
}

function post(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!ENABLED)("scratch engine: sequenced, replayable global stream (#1776)", () => {
  let engine: ChildProcess;
  let scratch: string;
  let log = "";
  const lines = (message: string) => log.split("\n").filter((l) => l.includes(`message="${message}"`));

  beforeAll(async () => {
    if (!(PORT >= 4190 && PORT <= 4199)) throw new Error(`scratch port ${PORT} outside 4190-4199`);
    if (!existsSync(BIN)) throw new Error(`no compiled engine at ${BIN} — run build:binary first`);
    scratch = mkdtempSync(join(tmpdir(), "amicode-scratch-engine-"));
    const proj = join(scratch, "proj");
    mkdirSync(proj);
    mkdirSync(join(scratch, "home"));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(OPENCODE|AMICO)/.test(k)) env[k] = v;
    Object.assign(env, {
      HOME: join(scratch, "home"),
      XDG_DATA_HOME: join(scratch, "data"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_STATE_HOME: join(scratch, "state"),
      XDG_CACHE_HOME: join(scratch, "cache"),
      OPENCODE_DB: join(scratch, "db.sqlite"),
    });
    engine = spawn(BIN, ["serve", "--port", String(PORT), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO", "--pure"], {
      cwd: proj,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    engine.stdout?.on("data", (d: Buffer) => (log += d));
    engine.stderr?.on("data", (d: Buffer) => (log += d));
    await until(() => log.includes(`listening on http://127.0.0.1:${PORT}`) || undefined, "engine listen", 60_000);
  }, 90_000);

  afterAll(async () => {
    engine?.kill("SIGTERM");
    await sleep(1_000);
    if (engine && engine.exitCode === null && engine.signalCode === null) engine.kill("SIGKILL");
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("replays exactly the frames after a Last-Event-ID cursor, then continues live", async () => {
    const a = stream();
    await a.opened;
    const connected = await until(() => a.frames[0], "connected frame");
    expect(connected.type).toBe("server.connected");
    const { epoch } = seqOf(connected);

    expect(await post("/session")).toBe(200);
    await until(() => a.frames.length >= 3 || undefined, "session events on the first connection");
    await sleep(500);
    const [first, ...afterCursor] = a.frames.slice(1);
    a.abort();

    expect(await post("/session")).toBe(200); // published while no one is connected
    const b = stream({ "last-event-id": first.id });
    await b.opened;
    await until(() => b.frames.length >= afterCursor.length + 3 || undefined, "replay and gap frames");
    await sleep(500);

    expect(b.frames[0].type).toBe("server.connected");
    expect(b.frames[0].id).toBe(first.id);
    const replayed = b.frames.slice(1);
    // the frames the first connection saw after the cursor, byte for byte, then the gap
    expect(replayed.slice(0, afterCursor.length)).toEqual(afterCursor);
    const gap = replayed.slice(afterCursor.length).filter((f) => f.type !== "server.heartbeat");
    expect(gap.map((f) => f.type)).toContain("session.created");
    // one epoch; ids never decrease and bus events never skip a sequence
    let previous = seqOf(first).seq;
    for (const frame of replayed) {
      const { epoch: e, seq } = seqOf(frame);
      expect(e).toBe(epoch);
      expect(seq - previous === 0 || seq - previous === 1).toBe(true);
      previous = seq;
    }
    b.abort();
  }, 30_000);

  it("a client that aborts mid-stream releases its subscription, and the release is logged", async () => {
    const clients = Array.from({ length: 5 }, () => stream());
    await Promise.all(clients.map((c) => c.opened));
    await until(() => clients.every((c) => c.frames.length > 0) || undefined, "connected frames");
    for (const c of clients) c.abort();
    await until(
      () => lines("global event disconnected").length === lines("global event connected").length || undefined,
      "one disconnect per connect",
    );
    expect(lines("global event connected").length).toBeGreaterThanOrEqual(5);
    expect(lines("global event disconnected").at(-1)).toContain("subscribers=0");
  }, 30_000);
});
