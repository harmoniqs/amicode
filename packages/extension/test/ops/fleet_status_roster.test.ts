// fleet_status_roster.test.ts — #1318 (ADR 0026), AC5: the reachability status
// job (ops/fleet-status.sh) derives its device list from the host-owned roster
// rows, NOT the hardcoded DEVICES=(...) bash array (which this slice removes).
//
// A "dry-run / shellcheck-level" test per the Testing Decisions — lighter than
// standing up the whole job (which ssh-probes, sqlites, curls). It leans on a
// new `--emit-devices` dry-run that prints the derived `name:host` device list
// and exits BEFORE any of that, seeded against a temp HOME roster.json. Plus a
// source guard that the hardcoded array is gone.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const EXT_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.resolve(EXT_ROOT, "..", "..", "ops", "fleet-status.sh");

// python3 + bash back the derivation the job already uses; skip cleanly if the
// environment lacks them (honest degradation, never a false green).
const HAS_TOOLS =
  spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).status === 0;

function seedRoster(home: string, rows: unknown[]): void {
  const dir = path.join(home, ".amico", "ops", "fleet");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "roster.json"), JSON.stringify({ schema_version: 1, rows }, null, 2));
}

function emitDevices(home: string): { code: number; lines: string[] } {
  const r = spawnSync("bash", [SCRIPT, "--emit-devices"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  const lines = (r.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return { code: r.status ?? -1, lines };
}

describe("ops/fleet-status.sh — AC5: the device list is derived from the roster, not hardcoded", () => {
  it("the hardcoded DEVICES=(...) array literal is REMOVED from the script", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/DEVICES=\(\s*"mini:127\.0\.0\.1"/); // the old hardcoded fleet is gone
    expect(src).toMatch(/roster\.json/); // and the roster is what it reads instead
  });

  (HAS_TOOLS ? it : it.skip)("--emit-devices derives name:host pairs from the roster rows", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-status-roster-"));
    try {
      seedRoster(home, [
        { machine_id: "mac-studio-01", name: "Studio", server_mode: "server", capabilities: [], sshAlias: "studio", transport: "tailscale", last_report: "2026-09-20T10:00:00Z", health: "reachable" },
        { machine_id: "macbook-02", name: "MacBook", server_mode: "client", capabilities: ["roaming"], sshAlias: "macbook-alias", transport: "ssh", last_report: "2026-09-20T11:00:00Z", health: "reachable" },
      ]);
      const { code, lines } = emitDevices(home);
      expect(code).toBe(0);
      // exactly the roster's devices, name:sshAlias — nothing hardcoded
      expect(lines.sort()).toEqual(["MacBook:macbook-alias", "Studio:studio"]);
      // the retired hardcoded peers must NOT appear
      expect(lines.join("\n")).not.toMatch(/erlich/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  (HAS_TOOLS ? it : it.skip)("an absent roster emits only the local machine — never the old hardcoded peers", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-status-empty-"));
    try {
      const { code, lines } = emitDevices(home); // no roster seeded
      expect(code).toBe(0);
      expect(lines.join("\n")).not.toMatch(/macbook|erlich|mini/); // no invented peers
      // a single loopback self-row keeps the widget honest (this machine only)
      expect(lines.every((l) => l.endsWith(":127.0.0.1"))).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
