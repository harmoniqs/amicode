import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeStopFile, savePulseTo, catalogPulsesDir } from "../src/run_controls";

describe("run_controls", () => {
  it("writeStopFile drops a STOP file into the run dir", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeStopFile(d);
    expect(existsSync(join(d, "STOP"))).toBe(true);
  });

  it("savePulseTo copies pulse.jld2 to the destination", () => {
    const src = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(src, "pulse.jld2"), "PULSEBYTES");
    const dst = join(mkdtempSync(join(tmpdir(), "out-")), "my.jld2");
    savePulseTo(src, dst);
    expect(readFileSync(dst, "utf8")).toBe("PULSEBYTES");
  });

  it("savePulseTo throws a clear error when no pulse.jld2 exists", () => {
    const src = mkdtempSync(join(tmpdir(), "run-"));
    expect(() => savePulseTo(src, join(tmpdir(), "x.jld2"))).toThrow(/no pulse/i);
  });

  it("catalogPulsesDir returns the dir when the team-vault catalog is present, else undefined", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    expect(catalogPulsesDir(home)).toBeUndefined();
    const catalog = join(home, ".amico", "vaults", "armonissima", "catalog", "pulses");
    mkdirSync(catalog, { recursive: true });
    expect(catalogPulsesDir(home)).toBe(catalog);
  });
});

// --- stop escalation ---------------------------------------------------------
import { utimesSync } from "node:fs";
import { stopPlan, forceFinalize, findRunPids, runScriptPath, STALL_AFTER_MS } from "../src/run_controls";
import { validateFinished } from "@amicode/amico-run";
import { parse as parseToml } from "smol-toml";

const ago = (d: string, file: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(join(d, file), t, t);
};

describe("stopPlan", () => {
  it("already-finished when FINISHED exists", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    expect(stopPlan(d)).toBe("already-finished");
  });
  it("cooperative while run.log is fresh", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.log"), "AMICODE_ITER iter=1 f=0.5\n");
    expect(stopPlan(d)).toBe("cooperative");
  });
  it("force once run.log has gone cold past the stall threshold", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.log"), "AMICODE_ITER iter=8 f=10.7\n");
    ago(d, "run.log", STALL_AFTER_MS + 60_000);
    expect(stopPlan(d)).toBe("force");
  });
  it("no run.log: judged by run-dir age (warming-up young vs zombie old)", () => {
    const young = mkdtempSync(join(tmpdir(), "run-"));
    expect(stopPlan(young)).toBe("cooperative");
    const old = mkdtempSync(join(tmpdir(), "run-"));
    ago(old, ".", STALL_AFTER_MS + 60_000);
    expect(stopPlan(old)).toBe("force");
  });
});

describe("forceFinalize", () => {
  it("writes a schema-valid FINISHED (aborted) and a run.log breadcrumb", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.log"), "AMICODE_ITER iter=8 f=10.7\n");
    forceFinalize(d);
    const finished = parseToml(readFileSync(join(d, "FINISHED"), "utf8"));
    expect(validateFinished(finished).ok).toBe(true);
    expect((finished as Record<string, unknown>).status).toBe("aborted");
    expect(readFileSync(join(d, "run.log"), "utf8")).toMatch(/AMICODE_ABORTED/);
  });
  it("survives a missing run.log (breadcrumb is best-effort)", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    forceFinalize(d);
    expect(existsSync(join(d, "FINISHED"))).toBe(true);
  });
});

describe("findRunPids (two-key match: cmdline AND cwd)", () => {
  const RUN_DIR = "/fake/runs/default/r1";
  const SCRIPT = "/fake/problems/x/solve.jl";
  const fakeExec = (psLines: string, cwdByPid: Record<string, string>) =>
    (cmd: string, args: string[]): string => {
      if (cmd === "/bin/ps") return psLines;
      const pid = args[args.indexOf("-p") + 1];
      if (!(pid in cwdByPid)) throw new Error("no such pid");
      return `p${pid}\nfcwd\nn${cwdByPid[pid]}\n`;
    };

  it("kills only processes running the script FROM this run dir", () => {
    const ps = [
      `  101 julia --project=/x ${SCRIPT}`,          // ours: script + cwd match
      `  202 julia --project=/x ${SCRIPT}`,          // sibling run, other cwd
      `  303 vim ${RUN_DIR}/run.log`,                // references dir, wrong cwd
      "  404 unrelated",
    ].join("\n");
    const pids = findRunPids(RUN_DIR, SCRIPT, fakeExec(ps, { "101": RUN_DIR, "202": "/fake/runs/default/r2", "303": "/home" }));
    expect(pids).toEqual([101]);
  });
  it("returns [] when nothing matches or lsof cannot prove ownership", () => {
    const ps = `  505 julia ${SCRIPT}\n`;
    expect(findRunPids(RUN_DIR, SCRIPT, fakeExec(ps, {}))).toEqual([]);
    expect(findRunPids(RUN_DIR, SCRIPT, () => { throw new Error("ps down"); })).toEqual([]);
  });
});

describe("runScriptPath", () => {
  it("reads script_path from run.toml", () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "run.toml"), 'run_id = "r1"\nscript_path = "/p/solve.jl"\n');
    expect(runScriptPath(d)).toBe("/p/solve.jl");
    expect(runScriptPath(mkdtempSync(join(tmpdir(), "run-")))).toBeUndefined();
  });
});

describe("forceStop finalize guard", () => {
  it("does not clobber a FINISHED that appeared before finalize", async () => {
    const d = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(d, "FINISHED"), 'status = "failed"\nexit_code = 143\n');
    const { forceStop } = await import("../src/run_controls");
    await forceStop(d);
    expect(readFileSync(join(d, "FINISHED"), "utf8")).toContain('"failed"');
  });
});
