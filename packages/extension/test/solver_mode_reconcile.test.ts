import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveSolverMode,
  issimoGranted,
  reconcileSolverMode,
  readSolverModeState,
} from "../src/solver_mode";

// The 2026-08-05 field report: a Piccolissimo + Altissimo solve ran locally on
// IPOPT. Cause: solver-mode.json read `piccolo` (dated a week earlier) while the
// issimo entitlement WAS granted and Harmoniqs Cloud was connected. Every cloud
// decision in the extension keys off that file — routing guidance, the template's
// SOLVER, the app's own toggle — so one dropped write silently reverted the whole
// paid tier, and nothing anywhere said so.

function ops(mode: string | undefined, codes: string[] | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "ops-"));
  if (mode !== undefined) writeFileSync(join(dir, "solver-mode.json"), JSON.stringify({ mode, status: "ready" }));
  if (codes !== undefined)
    writeFileSync(join(dir, "entitlements.toml"), `codes = [${codes.map((c) => `"${c}"`).join(", ")}]\n`);
  return dir;
}
const modeFile = (dir: string) => join(dir, "solver-mode.json");

describe("issimoGranted — the durable, self-cleaning record of the tier", () => {
  it("true when the entitlement carries issimo, false when it does not", () => {
    expect(issimoGranted(ops("piccolo", ["issimo"]))).toBe(true);
    expect(issimoGranted(ops("piccolo", ["something-else"]))).toBe(false);
  });
  it("absent / corrupt entitlements → false, never a throw (fresh install)", () => {
    expect(issimoGranted(ops("piccolo", undefined))).toBe(false);
    const d = ops("piccolo", undefined);
    writeFileSync(join(d, "entitlements.toml"), "{{ not toml");
    expect(issimoGranted(d)).toBe(false);
  });
});

describe("effectiveSolverMode — hp if EITHER signal says so", () => {
  it("the reported bug: stale piccolo file + granted entitlement → hp", () => {
    const d = ops("piccolo", ["issimo"]);
    expect(readSolverModeState(modeFile(d)).mode).toBe("piccolo"); // what the file says
    expect(effectiveSolverMode(modeFile(d), d)).toBe("hp"); // what we act on
  });
  it("file says hp, entitlement not yet written → still hp (switch mid-flight)", () => {
    const d = ops("hp", []);
    expect(effectiveSolverMode(modeFile(d), d)).toBe("hp");
  });
  it("both say piccolo → piccolo, so the free tier is untouched", () => {
    const d = ops("piccolo", []);
    expect(effectiveSolverMode(modeFile(d), d)).toBe("piccolo");
  });
  it("nothing on disk at all → piccolo (fail safe to the free local tier)", () => {
    expect(effectiveSolverMode(modeFile(ops(undefined, undefined)), ops(undefined, undefined))).toBe("piccolo");
  });
});

describe("reconcileSolverMode — heal the shared file at the source", () => {
  it("rewrites a stale piccolo file to hp, and says it healed", () => {
    // Healing the FILE (not just our own reads) is what fixes the other readers:
    // the app's solver toggle renders from it, and amico-run reads it directly.
    const d = ops("piccolo", ["issimo"]);
    const r = reconcileSolverMode(modeFile(d), d);
    expect(r).toEqual({ healed: true, mode: "hp" });
    expect(readSolverModeState(modeFile(d)).mode).toBe("hp"); // persisted
  });

  it("is a no-op when the file already agrees — no needless write, no false alarm", () => {
    const d = ops("hp", ["issimo"]);
    expect(reconcileSolverMode(modeFile(d), d)).toEqual({ healed: false, mode: "hp" });
  });

  it("never touches a switch in flight — the watcher owns that write", () => {
    // Racing the watcher would settle a switch at the wrong mode.
    const d = ops("piccolo", ["issimo"]);
    writeFileSync(modeFile(d), JSON.stringify({ mode: "piccolo", status: "switching" }));
    expect(reconcileSolverMode(modeFile(d), d).healed).toBe(false);
    expect(readSolverModeState(modeFile(d)).status).toBe("switching"); // left alone
  });

  it("does NOT auto-downgrade an hp file when the entitlement is missing", () => {
    // Deliberately asymmetric. A silent downgrade to a local solve is the exact
    // failure this change exists to kill, so `hp` is sticky: we never take the
    // cloud tier away from someone behind their back. The opposite direction is
    // cheap by comparison — an unentitled user who reaches the cloud gets a
    // "connect Harmoniqs Cloud" message, which is visible and actionable.
    //
    // Nothing is stranded by this: switching to Piccolo writes BOTH halves (the
    // entitlement revoke and the mode file), so the ordinary path still lands on
    // piccolo. This governs only the half-landed case.
    const d = ops("hp", []);
    expect(effectiveSolverMode(modeFile(d), d)).toBe("hp");
    expect(reconcileSolverMode(modeFile(d), d)).toEqual({ healed: false, mode: "hp" });
    expect(readFileSync(modeFile(d), "utf8")).toContain('"hp"'); // untouched
  });
});
