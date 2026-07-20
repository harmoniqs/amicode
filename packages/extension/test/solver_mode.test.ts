import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSolverModeState,
  writeSolverModeReady,
  applyEntitlementForMode,
  watchSolverMode,
  solverModeFile,
} from "../src/solver_mode";

describe("solver mode state", () => {
  it("defaults piccolo/ready; ready write round-trips", () => {
    const f = join(mkdtempSync(join(tmpdir(), "sm-")), "solver-mode.json");
    expect(readSolverModeState(f)).toEqual({ mode: "piccolo", status: "ready" });
    writeSolverModeReady("hp", f);
    expect(readSolverModeState(f)).toEqual({ mode: "hp", status: "ready" });
  });

  it("the SERVER's switching write ({mode, status:switching}) is what the watcher reads — the extension has no writer for it (#171)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "sm-")), "solver-mode.json");
    writeFileSync(f, JSON.stringify({ mode: "hp", status: "switching" })); // the fork server's write
    expect(readSolverModeState(f)).toEqual({ mode: "hp", status: "switching" });
  });
});

describe("applyEntitlementForMode", () => {
  it("hp grants issimo, piccolo revokes it, OTHER codes preserved both ways", () => {
    const dir = mkdtempSync(join(tmpdir(), "ents-"));
    writeFileSync(join(dir, "entitlements.toml"), 'codes = ["pasqal-hackathon-2026"]\n');
    expect(applyEntitlementForMode("hp", dir).codes).toEqual(["pasqal-hackathon-2026", "issimo"]);
    expect(readFileSync(join(dir, "entitlements.toml"), "utf8")).toContain('"issimo"');
    expect(applyEntitlementForMode("piccolo", dir).codes).toEqual(["pasqal-hackathon-2026"]);
    expect(readFileSync(join(dir, "entitlements.toml"), "utf8")).not.toContain("issimo");
  });
  it("idempotent grant (no duplicate issimo); creates the file from nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ents-"));
    applyEntitlementForMode("hp", dir);
    expect(applyEntitlementForMode("hp", dir).codes).toEqual(["issimo"]);
  });
});

describe("watchSolverMode", () => {
  it("fires once per switching request, then settles ready; busy latch holds", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "sm-")), "solver-mode.json");
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = watchSolverMode(
      async (m) => {
        calls.push(m);
        await gate;
      },
      f,
      20,
    );
    writeFileSync(f, JSON.stringify({ mode: "hp", status: "switching" }));
    await new Promise((r) => setTimeout(r, 120)); // several ticks while busy
    expect(calls).toEqual(["hp"]); // latch held — no re-entry
    release();
    await new Promise((r) => setTimeout(r, 80));
    expect(readSolverModeState(f)).toEqual({ mode: "hp", status: "ready" });
    w.dispose();
  });
});
