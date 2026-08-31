// Tests for "Amicode: Restart Hub Server" (amicode#649): the client-side
// decision logic (hub_ops.ts) with an injected runner/canary, plus a bash
// syntax check on the hub-side script — the restart-safe contract is only as
// good as the file that ships.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveHubTarget, isServingCode, restartHub, type RunResult, type HubRestartStep } from "../src/hub_ops";
import type { FleetConfig } from "../src/fleet_fallback";

const cfg = (canonical: FleetConfig["canonical"]): FleetConfig => ({ role: "client", canonical } as FleetConfig);

describe("resolveHubTarget", () => {
  it("resolves alias + host + port from the fleet config", () => {
    const t = resolveHubTarget(cfg({ host: "100.104.59.70", port: 4096, sshAlias: "amico-erlich" }));
    expect(t).toEqual({ alias: "amico-erlich", host: "100.104.59.70", port: 4096 });
  });

  it("defaults the port to 4096 when absent", () => {
    const t = resolveHubTarget(cfg({ host: "h", sshAlias: "hub" }));
    expect(t?.port).toBe(4096);
  });

  it("is null without an sshAlias (standalone / half-configured)", () => {
    expect(resolveHubTarget(cfg({ host: "h" }))).toBeNull();
    expect(resolveHubTarget(cfg({ host: "h", sshAlias: "  " }))).toBeNull();
    expect(resolveHubTarget(null)).toBeNull();
    expect(resolveHubTarget(undefined)).toBeNull();
  });

  it("trims the alias", () => {
    expect(resolveHubTarget(cfg({ host: "h", sshAlias: " hub " }))?.alias).toBe("hub");
  });
});

describe("isServingCode", () => {
  it("accepts 200 and 401 — the canary is 'the socket answers'", () => {
    expect(isServingCode(200)).toBe(true);
    expect(isServingCode(401)).toBe(true);
  });
  it("rejects everything else", () => {
    for (const code of [0, 404, 500, 502]) expect(isServingCode(code)).toBe(false);
  });
});

function fakeRunner(script: Array<Partial<RunResult>>): { run: (cmd: string[]) => Promise<RunResult>; calls: string[][] } {
  let i = 0;
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd) => {
      calls.push(cmd);
      const r = script[Math.min(i, script.length - 1)] ?? {};
      i++;
      return { code: 0, stdout: "", stderr: "", ...r };
    },
  };
}

const canaryOk = async () => 200;
const canaryDead = async () => 0;

describe("restartHub", () => {
  const target = { alias: "amico-erlich", host: "100.104.59.70", port: 4096 };
  const sshCmds = (calls: string[][]) => calls.map((c) => c[c.length - 1]);

  it("verifies → restarts → canaries, in that order, over ssh to the alias", async () => {
    const { run, calls } = fakeRunner([{ stdout: "verify: unit=active http=200 version=x\n" }, { stdout: "verify: unit=active http=200 version=x\n" }]);
    const r = await restartHub(target, run, canaryOk);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: HubRestartStep) => s.step)).toEqual(["precheck", "restart", "canary"]);
    expect(sshCmds(calls)).toEqual(["bash $HOME/.amico/ops/hub-restart.sh verify", "bash $HOME/.amico/ops/hub-restart.sh restart"]);
    expect(calls.every((c) => c.includes("amico-erlich"))).toBe(true);
  });

  it("a failed precheck never restarts", async () => {
    const { run, calls } = fakeRunner([{ code: 255, stderr: "ssh: connect failed" }]);
    const r = await restartHub(target, run, canaryOk);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.step).toBe("precheck");
    expect(r.steps[0]?.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a failed restart reports the script's output honestly and skips the canary", async () => {
    const { run, calls } = fakeRunner([
      { stdout: "verify: unit=active http=200 version=x\n" },
      { code: 1, stdout: "FAIL: hub not healthy after restart\n" },
    ]);
    const r = await restartHub(target, run, canaryOk);
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(["precheck", "restart"]);
    expect(r.steps[1]?.detail).toContain("FAIL");
  });

  it("a dead tunnel canary fails the whole run even when the hub-side restart succeeded", async () => {
    const { run } = fakeRunner([{ stdout: "verify: unit=active http=200 version=x\n" }, { stdout: "verify: unit=active http=200 version=x\n" }]);
    const r = await restartHub(target, run, canaryDead);
    expect(r.ok).toBe(false);
    expect(r.steps[2]?.step).toBe("canary");
    expect(r.steps[2]?.ok).toBe(false);
  });

  it("tolerates a runner that throws (ssh missing) as a failed precheck", async () => {
    const r = await restartHub(
      target,
      async () => {
        throw new Error("spawn ssh ENOENT");
      },
      canaryOk,
    );
    expect(r.ok).toBe(false);
    expect(r.steps[0]?.detail).toContain("ENOENT");
  });
});

describe("hub-restart.sh (the hub-side contract)", () => {
  const script = join(__dirname, "..", "..", "..", "ops", "hub-restart.sh");

  it("parses as valid bash", () => {
    expect(() => execFileSync("bash", ["-n", script], { stdio: "pipe" })).not.toThrow();
  });

  it("never contains a bare systemctl stop (the incident law)", () => {
    const src = require("node:fs").readFileSync(script, "utf8") as string;
    expect(src).not.toMatch(/systemctl\s+--user\s+stop\b/);
    expect(src).toMatch(/trap ensure_up EXIT/);
    expect(src).toMatch(/systemctl --user restart "\$UNIT"/);
  });
});
