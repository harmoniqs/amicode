import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { ServerManager } from "../src/server_manager";
import { serverLogPath } from "../src/server_handshake";
import { mintServerPassword, buildServerSpawnEnv } from "../src/server_auth";

// ============================================================================
// #1146 (ADR 0020): Detached spawn + deactivate stops killing
//
// Tests:
//  1. serverLogPath returns the expected path
//  2. Spawn args include --hostname 127.0.0.1 (loopback binding)
//  3. Detached spawn writes output to a log file
//  4. detach() leaves the server PID alive; stop() kills it
//  5. deactivate path (detach, not kill)
// ============================================================================

/** A fake `opencode` binary: shell shim → node http server on --port that
 *  writes its argv to `argsFile`, appends {url, authorization} per request
 *  to `captureFile`, and responds 200. */
function fakeOpencodeBinary(dir: string, captureFile: string, argsFile?: string): string {
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(
    serverMjs,
    [
      `import http from "node:http";`,
      `import { appendFileSync, writeFileSync } from "node:fs";`,
      // Capture argv for loopback test
      argsFile ? `writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv) + "\\n");` : "",
      `const portIdx = process.argv.indexOf("--port");`,
      `const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 0;`,
      `http.createServer((req, res) => {`,
      `  appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null }) + "\\n");`,
      `  res.end("ok");`,
      `}).listen(port, "127.0.0.1", () => console.log("fake opencode serving on port " + port));`,
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

// ── serverLogPath ──────────────────────────────────────────────────────────

describe("serverLogPath — log file path helper (#1146)", () => {
  it("returns the default path under ~/.amico/ops/server/", () => {
    const p = serverLogPath();
    expect(p).toBe(join(homedir(), ".amico", "ops", "server", "server.log"));
  });

  it("respects a custom ops root", () => {
    const p = serverLogPath("/tmp/custom-ops");
    expect(p).toBe(join("/tmp/custom-ops", "server", "server.log"));
  });
});

// ── Loopback binding ───────────────────────────────────────────────────────

describe("ServerManager — loopback binding (#1146 AC2)", () => {
  it("passes --hostname 127.0.0.1 in spawn args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-loopback-"));
    const captureFile = join(dir, "requests.jsonl");
    const argsFile = join(dir, "argv.json");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile, argsFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    try {
      await manager.start();
    } finally {
      await manager.stop();
    }
    expect(existsSync(argsFile)).toBe(true);
    const argv: string[] = JSON.parse(readFileSync(argsFile, "utf8").trim());
    const hostnameIdx = argv.indexOf("--hostname");
    expect(hostnameIdx).toBeGreaterThanOrEqual(0);
    expect(argv[hostnameIdx + 1]).toBe("127.0.0.1");
  }, 15_000);

  it("URL always uses 127.0.0.1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-url-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    try {
      await manager.start();
      expect(manager.url?.hostname).toBe("127.0.0.1");
    } finally {
      await manager.stop();
    }
  }, 15_000);
});

// ── Detached spawn + log file ──────────────────────────────────────────────

describe("ServerManager — detached spawn + log file (#1146 AC1/AC3)", () => {
  it("writes server output to the log file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-logfile-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    try {
      await manager.start();
      // The fake binary writes "fake opencode serving on port ..." to stdout,
      // which with the detached log-file spawn goes to the log file.
      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("fake opencode serving");
    } finally {
      await manager.stop();
    }
  }, 15_000);

  it("mirrors log file content into the output channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-tail-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { lines, channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    try {
      await manager.start();
      // Give the tailer one tick to catch up
      await new Promise((r) => setTimeout(r, 300));
      const text = lines.join("\n");
      expect(text).toContain("fake opencode serving");
    } finally {
      await manager.stop();
    }
  }, 15_000);

  it("log file bytes survive detach (not truncated)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-detach-log-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    await manager.start();
    const sizeBeforeDetach = statSync(logFile).size;
    expect(sizeBeforeDetach).toBeGreaterThan(0);

    // Detach — should NOT truncate the log
    manager.detach();

    const sizeAfterDetach = statSync(logFile).size;
    expect(sizeAfterDetach).toBeGreaterThanOrEqual(sizeBeforeDetach);
    // Content is unchanged
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain("fake opencode serving");
  }, 15_000);
});

// ── Detach vs Stop ─────────────────────────────────────────────────────────

describe("ServerManager — detach vs stop (#1146 AC5)", () => {
  it("detach() leaves the server PID alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-detach-pid-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    await manager.start();
    const pid = manager.pid;
    expect(pid).toBeGreaterThan(0);

    // Detach — process should still be alive
    manager.detach();

    // Check PID is alive (signal 0 = existence check)
    let alive = false;
    try {
      process.kill(pid!, 0);
      alive = true;
    } catch { alive = false; }
    expect(alive).toBe(true);

    // Clean up: kill the orphaned process
    try { process.kill(pid!, "SIGTERM"); } catch {}
  }, 15_000);

  it("stop() kills the server PID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-stop-pid-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    await manager.start();
    const pid = manager.pid;
    expect(pid).toBeGreaterThan(0);

    // Stop — process should die
    await manager.stop();

    // Give OS a moment to reap the process
    await new Promise((r) => setTimeout(r, 200));

    let alive = false;
    try {
      process.kill(pid!, 0);
      alive = true;
    } catch { alive = false; }
    expect(alive).toBe(false);
  }, 15_000);

  it("detach() is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-idem-"));
    const captureFile = join(dir, "requests.jsonl");
    const logFile = join(dir, "server.log");
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir, captureFile),
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      channel,
      logFile,
    });
    await manager.start();
    const pid = manager.pid;

    manager.detach();
    manager.detach(); // should not throw

    expect(manager.ready).toBe(false);

    // Clean up
    try { process.kill(pid!, "SIGTERM"); } catch {}
  }, 15_000);
});
