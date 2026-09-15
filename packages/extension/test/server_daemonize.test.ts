import { describe, it, expect } from "vitest";
import * as cp from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import {
  buildLauncherInvocation,
  daemonizeSpawn,
  freePortIfOurs,
} from "../src/server_daemonize";
import { ServerManager } from "../src/server_manager";

// ============================================================================
// #1183 (ADR 0020): daemonize the standalone server so it survives a VS Code
// window reload. Real-process harness — ephemeral ports, tmpdir log files,
// fake binaries. NEVER touches ~/.amico/ops/server/ or port 43117, so it is
// safe to run alongside a live session.
//
// Acceptance criteria (spec-20260914-205414):
//   daemon_reparented_off_spawner · daemon_survives_spawner_exit ·
//   handshake_records_server_pid · stop_terminates_daemon ·
//   stop_before_pid_known_frees_port · health_gate_blocks_until_ready
// ============================================================================

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ppidOf(pid: number): number | undefined {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, { timeout: 5000 }).toString().trim();
    return /^\d+$/.test(out) ? parseInt(out, 10) : undefined;
  } catch {
    return undefined;
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) { const p = addr.port; srv.close(() => resolve(p)); }
      else { srv.close(); reject(new Error("no port")); }
    });
    srv.on("error", reject);
  });
}

/** Fake `opencode`: sh shim → node http server on --port; stays alive; 200s. */
function fakeOpencodeBinary(dir: string): string {
  const serverMjs = join(dir, "fake_serve.mjs");
  writeFileSync(serverMjs, [
    `import http from "node:http";`,
    `const i = process.argv.indexOf("--port");`,
    `const port = i >= 0 ? Number(process.argv[i + 1]) : 0;`,
    `http.createServer((_, res) => res.end("ok")).listen(port, "127.0.0.1", () => console.log("fake opencode serving on " + port));`,
  ].join("\n"));
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${serverMjs}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function captureChannel() {
  const lines: string[] = [];
  return { lines, channel: { appendLine: (l: string) => lines.push(l), append: (l: string) => lines.push(l) } as never };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── buildLauncherInvocation (pure — S5 smoke) ────────────────────────────────

describe("buildLauncherInvocation (#1183)", () => {
  it("targets execPath as electron-as-node with the launcher script", () => {
    const inv = buildLauncherInvocation({
      binary: "/x/opencode", args: ["serve", "--port", "1"], cwd: "/x",
      env: { PATH: "/usr/bin" }, logFile: "/x/ops/server.log", execPath: "/fake/node", launcherDir: "/x/ops",
    });
    expect(inv.command).toBe("/fake/node");
    expect(inv.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(inv.env.AMICO_LAUNCH_BINARY).toBe("/x/opencode");
    expect(inv.args).toEqual([join("/x/ops", "server_launcher.mjs")]);
  });
});

// ── daemonizeSpawn (real process) ────────────────────────────────────────────

describe("daemonizeSpawn (#1183)", () => {
  it("daemon_reparented_off_spawner: server PPID is not this process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dz-reparent-"));
    const port = await getFreePort();
    const { serverPid } = await daemonizeSpawn({
      binary: fakeOpencodeBinary(dir), args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: dir, env: { PATH: process.env.PATH ?? "" }, logFile: join(dir, "server.log"),
    });
    try {
      expect(isAlive(serverPid)).toBe(true);
      expect(ppidOf(serverPid)).not.toBe(process.pid);
    } finally {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
  }, 15_000);

  it("daemon_survives_spawner_exit: server outlives the launcher that spawned it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dz-survive-"));
    const port = await getFreePort();
    const { serverPid, launcherPid } = await daemonizeSpawn({
      binary: fakeOpencodeBinary(dir), args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: dir, env: { PATH: process.env.PATH ?? "" }, logFile: join(dir, "server.log"),
    });
    try {
      await sleep(200);
      expect(isAlive(serverPid)).toBe(true);          // still alive
      expect(ppidOf(serverPid)).not.toBe(launcherPid); // reparented — its spawner is gone
    } finally {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
  }, 15_000);
});

// ── freePortIfOurs (D6 / stop_before_pid_known) ──────────────────────────────

describe("freePortIfOurs (#1183)", () => {
  function plantListener(port: number): number {
    const child = cp.spawn(process.execPath, [
      "-e", `require("http").createServer((_,r)=>r.end("x")).listen(${port},"127.0.0.1")`,
    ], { stdio: "ignore" });
    return child.pid!;
  }

  it("frees the port when the holder is OURS", async () => {
    const port = await getFreePort();
    const pid = plantListener(port);
    await sleep(300);
    const freed = await freePortIfOurs(port, {
      pidOnPort: () => (isAlive(pid) ? pid : undefined),
      isOurs: () => true,
      kill: (p, s) => process.kill(p, s),
      sleep,
    });
    expect(freed).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  it("NEVER kills a FOREIGN holder", async () => {
    const port = await getFreePort();
    const pid = plantListener(port);
    await sleep(300);
    try {
      const freed = await freePortIfOurs(port, {
        pidOnPort: () => (isAlive(pid) ? pid : undefined),
        isOurs: () => false,          // foreign
        kill: (p, s) => process.kill(p, s),
        sleep,
      });
      expect(freed).toBe(false);
      expect(isAlive(pid)).toBe(true); // untouched
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }, 15_000);
});

// ── ServerManager daemonized (logFile) path ──────────────────────────────────

describe("ServerManager — daemonized path (#1183)", () => {
  it("daemon_reparented_off_spawner: manager.pid escaped this process's subtree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-dz-reparent-"));
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir), cwd: dir, env: { PATH: process.env.PATH ?? "" },
      channel, logFile: join(dir, "server.log"),
    });
    await manager.start();
    const pid = manager.pid!;
    try {
      expect(isAlive(pid)).toBe(true);
      expect(ppidOf(pid)).not.toBe(process.pid);
    } finally {
      await manager.stop();
    }
  }, 20_000);

  it("handshake_records_server_pid: afterHealthy pid is the live server, not a launcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-dz-pid-"));
    const { channel } = captureChannel();
    let hookPid: number | undefined;
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir), cwd: dir, env: { PATH: process.env.PATH ?? "" },
      channel, logFile: join(dir, "server.log"),
      afterHealthy: (info) => { hookPid = info.pid; },
    });
    await manager.start();
    try {
      expect(hookPid).toBe(manager.pid);
      expect(isAlive(hookPid!)).toBe(true);
    } finally {
      await manager.stop();
    }
  }, 20_000);

  it("health_gate_blocks_until_ready: server answers a probe by the time start resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-dz-health-"));
    const { channel } = captureChannel();
    let firedReady = false;
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir), cwd: dir, env: { PATH: process.env.PATH ?? "" },
      channel, logFile: join(dir, "server.log"),
      afterHealthy: () => { firedReady = true; },
    });
    await manager.start();
    try {
      expect(firedReady).toBe(true);
      expect(manager.ready).toBe(true);
      const r = await fetch(`http://127.0.0.1:${manager.port}/`);
      expect(r.ok || (r.status >= 200 && r.status < 400)).toBe(true);
    } finally {
      await manager.stop();
    }
  }, 20_000);

  it("stop_terminates_daemon: stop() kills the daemonized server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-dz-stop-"));
    const { channel } = captureChannel();
    const manager = new ServerManager({
      binary: fakeOpencodeBinary(dir), cwd: dir, env: { PATH: process.env.PATH ?? "" },
      channel, logFile: join(dir, "server.log"),
    });
    await manager.start();
    const pid = manager.pid!;
    await manager.stop();
    await sleep(300);
    expect(isAlive(pid)).toBe(false);
  }, 20_000);
});
