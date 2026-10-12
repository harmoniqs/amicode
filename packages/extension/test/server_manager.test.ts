import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerManager } from "../src/server_manager";
import { mintServerPassword, serverAuthHeader, serverAuthToken, buildServerSpawnEnv } from "../src/server_auth";

// ============================================================================
// #163: ServerManager injects OPENCODE_SERVER_PASSWORD into the spawn — so its
// OWN health probe must authenticate, or the fork 401s `GET /` and a perfectly
// healthy boot reads "did not become healthy within 30s". Integration-style
// against a REAL spawn of a fake `opencode serve` (a script that records each
// request's Authorization header to a file — never to stdout, mirroring the
// real binary which never prints its env), plus the AC3 scan: everything the
// manager writes to the output channel is captured and swept for the secret.
// ============================================================================

/** A fake `opencode` binary: shell shim → node http server on --port that
 *  appends {url, authorization} per request to `captureFile` and 200s. */
function fakeOpencodeBinary(dir: string, captureFile: string): string {
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(
    serverMjs,
    [
      `import http from "node:http";`,
      `import { appendFileSync } from "node:fs";`,
      `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);`,
      `http.createServer((req, res) => {`,
      `  appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null }) + "\\n");`,
      `  res.end("ok");`,
      `}).listen(port, "127.0.0.1", () => console.log("fake opencode serving"));`,
    ].join("\n"),
  );
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${serverMjs}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function captureChannel() {
  const lines: string[] = [];
  return {
    lines,
    channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never,
  };
}

describe("ServerManager — health probe under the per-boot password (#163)", () => {
  it("authenticates its own probe with the credential it injected (AC2) and never logs the secret (AC3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-auth-"));
    const captureFile = join(dir, "requests.jsonl");
    const password = mintServerPassword();
    const { lines, channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      // The REAL spawn-env builder — the probe must derive its credential from
      // the same env the child gets, so the two can never drift.
      env: buildServerSpawnEnv({ amicoRunBinDir: undefined, configContent: "{}", serverPassword: password }),
      channel,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    const probes = readFileSync(captureFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { url: string; authorization: string | null });
    expect(probes.length).toBeGreaterThan(0);
    // EVERY probe carried the matching Basic credential — a 401'd first poll
    // would still pass a some() assertion, so pin all of them.
    for (const p of probes) expect(p.authorization).toBe(serverAuthHeader(password));
    // AC3: the channel captured the whole boot (spawn line, child stdout,
    // ready line) and the secret appears in none of it, in no encoding.
    const text = lines.join("\n");
    expect(text).toContain("fake opencode serving"); // child stdout really flowed through
    expect(text).toMatch(/\[server\] ready at http:\/\/127\.0\.0\.1:\d+/);
    expect(text).not.toContain(password);
    expect(text).not.toContain(serverAuthToken(password));
  }, 15_000);

  it("probes without a header when no password is in the spawn env (dev override path unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-noauth-"));
    const captureFile = join(dir, "requests.jsonl");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    expect(existsSync(captureFile)).toBe(true);
    const probes = readFileSync(captureFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { authorization: string | null });
    for (const p of probes) expect(p.authorization).toBeNull();
  }, 15_000);
});

// ============================================================================
// #1144 (ADR 0020): the afterHealthy hook fires after health passes, BEFORE
// onReady — cold-spawn handshake writes hook in here.
// ============================================================================

// ============================================================================
// #1595: ServerManager.seed() — adopt an already-running engine into a manager
// so stop()/start() work on adopted windows.
// ============================================================================

describe("ServerManager.seed() — adopt-safe lifecycle (#1595)", () => {
  it("creates a manager with the seeded port and pid", () => {
    const { channel } = captureChannel();
    const mgr = ServerManager.seed(
      { binary: "/fake/opencode", cwd: "/tmp", env: {}, channel },
      { port: 43117, pid: 12345 },
    );
    expect(mgr.port).toBe(43117);
    expect(mgr.pid).toBe(12345);
  });

  it("reports url derived from the seeded port", () => {
    const { channel } = captureChannel();
    const mgr = ServerManager.seed(
      { binary: "/fake/opencode", cwd: "/tmp", env: {}, channel },
      { port: 43117, pid: 12345 },
    );
    expect(mgr.url?.toString()).toBe("http://127.0.0.1:43117/");
  });

  it("stop() sends SIGTERM to the seeded PID", async () => {
    const { channel } = captureChannel();
    const mgr = ServerManager.seed(
      { binary: "/fake/opencode", cwd: "/tmp", env: {}, channel },
      { port: 43117, pid: process.pid }, // use own PID so it's "alive"
    );
    // Mock process.kill to capture calls without actually killing
    const killCalls: Array<{ pid: number; signal: string | number }> = [];
    const origKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? "SIGTERM" });
      // signal 0 = existence probe → return true (alive); else no-op
      if (signal === 0) return true;
    }) as typeof process.kill;
    try {
      await mgr.stop();
    } finally {
      process.kill = origKill;
    }
    // Must have sent SIGTERM to the seeded PID
    expect(killCalls.some((c) => c.pid === process.pid && c.signal === "SIGTERM")).toBe(true);
  });

  it("after stop(), start() spawns fresh (no 'already running' error)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-seed-restart-"));
    const captureFile = join(dir, "requests.jsonl");
    const { channel } = captureChannel();
    const mgr = ServerManager.seed(
      { binary: fakeOpencodeBinary(dir, captureFile), cwd: dir, env: { PATH: process.env.PATH ?? "" }, channel },
      { port: 43117, pid: 99999 }, // fake PID (dead — stop() will be a no-op kill)
    );
    // Mock process.kill so stop() doesn't fail on the dead PID
    const origKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error("no such process"); // pidIsAlive → false
    }) as typeof process.kill;
    try {
      await mgr.stop();
    } finally {
      process.kill = origKill;
    }
    // Now start() should spawn a fresh server — no "already running" error
    try {
      const url = await mgr.start();
      expect(url).toBeDefined();
      expect(mgr.port).toBeGreaterThan(0);
    } finally {
      await mgr.stop();
    }
  }, 15_000);

  it("afterHealthy fires with new port/pid after stop-then-start on a seeded manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-seed-onready-"));
    const captureFile = join(dir, "requests.jsonl");
    const { channel } = captureChannel();
    let hookPort: number | undefined;
    let hookPid: number | undefined;
    const mgr = ServerManager.seed(
      {
        binary: fakeOpencodeBinary(dir, captureFile),
        cwd: dir,
        env: { PATH: process.env.PATH ?? "" },
        channel,
        afterHealthy: (info) => { hookPort = info.port; hookPid = info.pid; },
      },
      { port: 43117, pid: 99999 },
    );
    // Stop the "adopted" engine (dead PID — no-op kill)
    const origKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error("no such process");
    }) as typeof process.kill;
    try {
      await mgr.stop();
    } finally {
      process.kill = origKill;
    }
    // Now start fresh — afterHealthy should run with the new engine's info
    try {
      const url = await mgr.start();
      expect(url).toBeDefined();
    } finally {
      await mgr.stop();
    }
    // afterHealthy must have fired for the fresh spawn (the handshake write hook)
    expect(hookPort).toBeGreaterThan(0);
    expect(hookPid).toBeGreaterThan(0);
  }, 15_000);
});

describe("ServerManager — afterHealthy hook (#1144)", () => {
  it("fires after health passes with the correct port and pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-hook-"));
    const captureFile = join(dir, "requests.jsonl");
    const { channel } = captureChannel();
    let hookPort: number | undefined;
    let hookPid: number | undefined;
    let hookFired = false;
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      afterHealthy: (info) => {
        hookFired = true;
        hookPort = info.port;
        hookPid = info.pid;
      },
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    // afterHealthy fired
    expect(hookFired).toBe(true);
    // port and pid are real
    expect(hookPort).toBeGreaterThan(0);
    expect(hookPid).toBeGreaterThan(0);
    expect(hookPort).toBe(manager.port);
  }, 15_000);
});
