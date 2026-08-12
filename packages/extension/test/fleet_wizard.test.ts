import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runPreflight,
  configureRemoteServer,
  configureLocalClient,
  removeMachine,
  dismantleFleet,
  generateFleetToken,
  buildServerLaunchdPlist,
  buildServerSystemdUnit,
  buildTunnelLaunchdPlist,
  type SshExecResult,
  type SshExec,
} from "../src/fleet_wizard";
import { readFleetConfig } from "../src/fleet_fallback";

// ── Mock SSH executor ───────────────────────────────────────────────────────

function mockExec(responses: Record<string, SshExecResult>): SshExec {
  return async (_target: string, command: string): Promise<SshExecResult> => {
    // Match by substring for flexibility
    for (const [key, result] of Object.entries(responses)) {
      if (command.includes(key)) return result;
    }
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
}

const OK: SshExecResult = { ok: true, stdout: "ok", stderr: "", code: 0 };
const FAIL: SshExecResult = { ok: false, stdout: "", stderr: "Connection refused", code: 1 };

// ── Pre-flight checks ───────────────────────────────────────────────────────

describe("runPreflight", () => {
  it("passes all checks with a healthy target", async () => {
    const exec = mockExec({
      "echo ok": { ok: true, stdout: "ok", stderr: "", code: 0 },
      "which": { ok: true, stdout: "/usr/local/bin/opencode", stderr: "", code: 0 },
      "lsof": { ok: true, stdout: "free", stderr: "", code: 0 },
    });
    const result = await runPreflight("test-host", { exec });
    expect(result.allPass).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails fast on SSH failure", async () => {
    const exec = mockExec({ "echo ok": FAIL });
    const result = await runPreflight("bad-host", { exec });
    expect(result.allPass).toBe(false);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].fix).toContain("SSH key-based auth");
    // Only 1 check because it fails fast
    expect(result.checks).toHaveLength(1);
  });

  it("fails on missing binary", async () => {
    const exec = mockExec({
      "echo ok": OK,
      "which": { ok: false, stdout: "", stderr: "", code: 1 },
      "lsof": { ok: true, stdout: "free", stderr: "", code: 0 },
    });
    const result = await runPreflight("test-host", { exec });
    expect(result.allPass).toBe(false);
    expect(result.checks[1].status).toBe("fail");
    expect(result.checks[1].fix).toContain("SCP");
  });

  it("fails on port taken", async () => {
    const exec = mockExec({
      "echo ok": OK,
      "which": { ok: true, stdout: "/usr/local/bin/opencode", stderr: "", code: 0 },
      "lsof": { ok: true, stdout: "taken", stderr: "", code: 0 },
    });
    const result = await runPreflight("test-host", { exec, port: 4096 });
    expect(result.allPass).toBe(false);
    expect(result.checks[2].status).toBe("fail");
    expect(result.checks[2].fix).toContain("port");
  });
});

// ── Remote server configuration ─────────────────────────────────────────────

describe("configureRemoteServer", () => {
  it("runs all steps successfully with a cooperative remote", async () => {
    const exec: SshExec = async () => OK;
    const steps = await configureRemoteServer("server-host", { exec, port: 4096, token: "abc123", platform: "darwin" });
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(steps).toHaveLength(4);
  });

  it("fails on mkdir failure and stops", async () => {
    const exec = mockExec({ "mkdir": FAIL });
    const steps = await configureRemoteServer("host", { exec });
    expect(steps[0].status).toBe("failed");
    expect(steps).toHaveLength(1); // Stopped after first failure
  });
});

// ── Local client configuration ──────────────────────────────────────────────

describe("configureLocalClient", () => {
  let tmp: string;
  let origFleetDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wizard-"));
    // We can't easily mock FLEET_DIR in fleet_fallback, so test indirectly
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns steps all done on success", () => {
    // configureLocalClient writes to the real FLEET_DIR, so we test the step structure
    const steps = configureLocalClient("remote-server", { port: 4096, sshAlias: "srv", token: "token123" });
    // At minimum the first two steps should succeed (fleet.json + token)
    expect(steps[0].name).toBe("Write local fleet.json");
    expect(steps[1].name).toBe("Store fleet token");
    // On macOS it will also have tunnel step
    if (process.platform === "darwin") {
      expect(steps.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ── Remove machine ──────────────────────────────────────────────────────────

describe("removeMachine", () => {
  it("reverts target to standalone and unloads services", async () => {
    const commands: string[] = [];
    const exec: SshExec = async (_t, cmd) => {
      commands.push(cmd);
      return OK;
    };
    const steps = await removeMachine("client-host", { exec });
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(commands.some((c) => c.includes("standalone"))).toBe(true);
  });

  it("handles revert failure", async () => {
    const exec: SshExec = async (_t, cmd) => {
      if (cmd.includes("fleet.json")) return FAIL;
      return OK;
    };
    const steps = await removeMachine("bad-host", { exec });
    expect(steps[0].status).toBe("failed");
  });
});

// ── Dismantle fleet ─────────────────────────────────────────────────────────

describe("dismantleFleet", () => {
  it("stops server, reverts remote, reverts local", async () => {
    const commands: string[] = [];
    const exec: SshExec = async (_t, cmd) => {
      commands.push(cmd);
      return OK;
    };
    const steps = await dismantleFleet("server-host", { exec, platform: "darwin" });
    expect(steps.length).toBeGreaterThanOrEqual(3);
    // Server stop + remote revert + local revert
    expect(steps.some((s) => s.name === "Stop server" && s.status === "done")).toBe(true);
    expect(steps.some((s) => s.name === "Revert local to standalone")).toBe(true);
  });
});

// ── Token generation ────────────────────────────────────────────────────────

describe("generateFleetToken", () => {
  it("produces a 64-char hex string", () => {
    const token = generateFleetToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it("generates unique tokens", () => {
    const t1 = generateFleetToken();
    const t2 = generateFleetToken();
    expect(t1).not.toBe(t2);
  });
});

// ── Service file generators ─────────────────────────────────────────────────

describe("buildServerLaunchdPlist", () => {
  it("includes the port in ProgramArguments", () => {
    const plist = buildServerLaunchdPlist(4096);
    expect(plist).toContain("4096");
    expect(plist).toContain("co.harmoniqs.amico-server");
    expect(plist).toContain("opencode");
    expect(plist).toContain("serve");
  });
});

describe("buildServerSystemdUnit", () => {
  it("includes the port in ExecStart", () => {
    const unit = buildServerSystemdUnit(5000);
    expect(unit).toContain("5000");
    expect(unit).toContain("opencode serve");
    expect(unit).toContain("Restart=always");
  });
});

describe("buildTunnelLaunchdPlist", () => {
  it("includes SSH alias, port forwarding, and keepalive settings", () => {
    const plist = buildTunnelLaunchdPlist("my-server", 4096);
    expect(plist).toContain("my-server");
    expect(plist).toContain("127.0.0.1:4096:127.0.0.1:4096");
    expect(plist).toContain("ServerAliveInterval=15");
    expect(plist).toContain("ServerAliveCountMax=2");
    expect(plist).toContain("TCPKeepAlive=yes");
  });
});
