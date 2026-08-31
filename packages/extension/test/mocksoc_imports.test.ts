// SEAM 1 (amicode #680) — the import-surface invariant, made mechanical:
// `rehearsal_imports_strumento_path_only == 1`.
//
// The rehearsal entry point (templates/mocksoc_rehearsal.jl) must import NO
// sim module outside the Strumento.jl path — the entire point is that the
// preview exercises the identical transport seam real hardware uses (F1: if
// the real path cannot be used, ship NOTHING). This scan is the "verbatim"
// check: every `using`/`import` line in the entry point must name a module in
// the allowlist, and the allowlist maps each module to WHY it is on it. A new
// import outside the list reds this test — bespoke sim cannot sneak in.
//
// (The module GRAPH below the entry point is Intonato/Piccolo/Strumento's own
// dependency surface, resolved by Pkg from the committed rehearsal env — the
// source scan pins the seam's author-facing surface, which is the part this
// repo controls.)
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "templates", "mocksoc_rehearsal.jl");

/** The allowlist: module → the Strumento-path family it belongs to. */
const ALLOWED: Record<string, string> = {
  // the chassis WITH the absorbed hardware seam (StrumentoBackend /
  // StrumentoExperiment / PulseTuningProblem / IdentityStrategy / MockSoc
  // reexport) — reexports Piccolo + Strumento's soc surface
  Intonato: "the QILC chassis; reexports Piccolo + Strumento's soc surface + MockSoc",
  Strumento: "the soc substrate (explicit reach without the Intonato reexport)",
  Piccolo: "the physics stack (systems, pulses, trajectories)",
  NamedTrajectories: "Piccolo's trajectory/pulse container (load_traj)",
  // stdlib + IO only — no simulation lives here
  JLD2: "stdlib-adjacent artifact IO (pulse.jld2)",
  TOML: "stdlib (result.toml read + rehearsal.toml write)",
  SHA: "stdlib (the pulse content-hash)",
  Dates: "stdlib (the recorded timestamp)",
  LinearAlgebra: "stdlib",
  Random: "stdlib",
  Printf: "stdlib",
  Statistics: "stdlib",
  Test: "stdlib (self-checks, if any)",
};

describe("rehearsal import surface (rehearsal_imports_strumento_path_only)", () => {
  it("the rehearsal entry point exists (a moved/renamed script reds the scan)", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("imports ONLY modules on the Strumento-path allowlist — no bespoke sim", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // Every using/import line in the file (module-level scope lines only:
    // `using A: b` qualified imports are covered by the same match).
    const lines = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(using|import)\s/.test(l));
    expect(lines.length).toBeGreaterThan(0); // a script with no imports at all is a scan failure
    const modules = lines.map((l) => {
      const m = l.match(/^(?:using|import)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (!m) throw new Error(`unparseable import line: ${l}`);
      return m[1];
    });
    const offenders = modules.filter((m) => !(m in ALLOWED));
    expect(
      offenders,
      `imports outside the Strumento path: ${offenders.join(", ")} — ` +
        `the rehearsal must ride Strumento/Intonato/Piccolo, nothing else`,
    ).toEqual([]);
  });

  it("no sim-lookalike module names appear anywhere in the script source", () => {
    // Belt + braces: the F1 guard. A bespoke sim would show up as a hand-rolled
    // rollout/propagation call that is NOT routed through the seam. The
    // transport verbs must come from the allowlisted modules; a source-level
    // ban-list catches the obvious lookalikes if they ever leak in.
    const src = readFileSync(SCRIPT, "utf8");
    const banned = [
      /\bQuantumToolbox\b/,
      /\bDifferentialEquations\b/,
      /\bOrdinaryDiffEq\b/,
      /\bSundials\b/,
      /\bKrylov\b/,
      /\bExponentialUtilities\b/,
    ];
    for (const re of banned) {
      expect(src.match(re), `banned sim dependency ${re} in the rehearsal entry point`).toBeNull();
    }
  });
});
