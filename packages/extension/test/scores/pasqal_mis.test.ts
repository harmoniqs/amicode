import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadRepertoire } from "../../src/scores/loader";
import { lintRepertoire } from "../../src/scores/lint";
import { filterRepertoire } from "../../src/scores/entitlements";
import { buildRouterSection } from "../../src/scores/router";
import { compileScore } from "../../src/scores/compiler";

// Contract tests for the shipped pasqal-mis score (the hackathon golden path,
// spec-20260703-025314 §7). These pin the REAL content on disk — a broken
// manifest, template path, or entitlement id must fail here, not at the event.

const EXT_ROOT = path.resolve(__dirname, "..", "..");
const SCORES = path.join(EXT_ROOT, "scores");
const ENT = "pasqal-hackathon-2026";

function loadMis() {
  const load = loadRepertoire(SCORES);
  const score = load.scores.find((s) => s.manifest.id === "pasqal-mis");
  expect(score, "pasqal-mis must load from the shipped repertoire").toBeTruthy();
  return { load, score: score! };
}

describe("pasqal-mis score (shipped content)", () => {
  it("loads, lints clean, and declares the hackathon entitlement", () => {
    const { load, score } = loadMis();
    const registry = parseToml(fs.readFileSync(path.join(SCORES, "entitlements.toml"), "utf8")) as {
      known: string[];
    };
    expect(lintRepertoire(load, path.join(SCORES, "memory"), registry.known)).toEqual([]);
    expect(score.manifest.entitlements).toEqual([ENT]);
    expect(score.manifest.device).toEqual({ backend: "pasqal", qpu_runnable: true, emulators: ["emu-mps"] });
  });

  it("is entitlement-gated: invisible publicly, visible (and routed) with the code", () => {
    const { load, score } = loadMis();
    const pub = filterRepertoire(load.scores, []);
    expect(pub.map((s) => s.manifest.id)).not.toContain("pasqal-mis");
    const entitled = filterRepertoire(load.scores, [ENT]);
    expect(entitled.map((s) => s.manifest.id)).toContain("pasqal-mis");
    // The onset router renders it as an application entry card (QPU-runnable badge).
    const router = buildRouterSection(entitled);
    expect(router).toContain("`pasqal-mis`");
    expect(router).toContain("QPU-runnable");
    expect(score.manifest.name.length).toBeGreaterThan(0);
  });

  it("carries the spec §7 stage spine with gates on the device stages", () => {
    const { score } = loadMis();
    const ids = score.manifest.stages.map((s) => s.id);
    expect(ids).toEqual(["application", "register", "formulate", "solve", "validate", "device-sim", "device-qpu"]);
    const byId = Object.fromEntries(score.manifest.stages.map((s) => [s.id, s]));
    expect(byId["solve"].executor).toBe("local"); // degraded mode until cloud-altissimo lands
    expect(byId["solve"].template).toBe("templates/solve.jl");
    expect(byId["device-sim"].gate).toBe("light");
    expect(byId["device-sim"].template).toBe("templates/register.py");
    expect(byId["device-sim"].optional).toBe(true);
    expect(byId["device-qpu"].gate).toBe("heavy");
    expect(byId["device-qpu"].optional).toBe(true);
    // Entity emissions stay inside the known-entity vocabulary (schema-validated),
    // and the application stage records the graph as the circuit/algorithm entity.
    expect(byId["application"].emits).toEqual(["circuit"]);
  });

  it("template files exist and carry their contracts (telemetry, waveforms seam, honesty lines)", () => {
    const { score } = loadMis();
    const solve = fs.readFileSync(path.join(score.dir, "templates", "solve.jl"), "utf8");
    for (const marker of [
      "AMICODE_PULSE_META",
      "AMICODE_ITER",
      "STOP",
      "result.toml",
      "pulse.jld2",
      "waveforms.json",
      "BLAS.set_num_threads(1)",
      "DONE fidelity=",
    ]) {
      expect(solve, `solve.jl must carry ${marker}`).toContain(marker);
    }
    // Verification doctrine: the reported number comes from a fresh rollout.
    expect(solve).toMatch(/KetTrajectory\(sys, pulse_opt/);

    const reg = fs.readFileSync(path.join(score.dir, "templates", "register.py"), "utf8");
    expect(reg).toContain("waveforms.json");
    expect(reg).toContain("pip install pulser"); // degraded mode is instructions, not a dead end
    expect(reg).toMatch(/not wired in this build/i); // no implied cloud/QPU submission
  });

  it("compiles into the prompt with numbered stages and gate banners", () => {
    const { score } = loadMis();
    const compiled = compileScore(score);
    expect(compiled).toContain("**application**");
    expect(compiled).toContain("🔒 gate: light");
    expect(compiled).toContain("🔒 gate: heavy");
    expect(compiled).toContain(path.join(score.dir, "templates/solve.jl"));
    // The prose body rides along verbatim (audience + honesty language).
    expect(compiled).toContain("no physics assumed");
  });
});
