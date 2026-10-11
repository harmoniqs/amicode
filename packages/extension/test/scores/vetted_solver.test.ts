// P3a (#1676, Q74 amended): the vetted score templates ride the MadNLP-default
// solve surface. DirectTrajOpt 0.11 flipped the no-kwarg `solve!` default to
// MadNLP (the #155 flip; QualityFunctionUpdate barrier), Piccolo 2.2 inherits it
// — these pins hold the templates to that contract:
//   - a solver-agnostic default construction (no options struct in the default
//     arm; the DTO default rides),
//   - the 60-iter budget (audit-safe: the DTO #155 restoration audit measured
//     0.99999996 @ 60 on the previously-failing seed class — no bump),
//   - Ipopt as the documented selectable path (IpoptOptions + the raw callback),
//   - the mode-filtered AMICODE_ITER emitter on the MadNLP arm (restore/robust
//     phases fire the callback WITHOUT advancing the counter — emitters filter
//     on regular mode; the agnostic `(primal, iter)` form cannot carry the
//     obj/inf_pr/inf_du columns the Inspector's stats row reads),
//   - a version probe that refuses pre-0.11 stacks loudly (never misbehaves).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scores = join(here, "..", "..", "scores");
const read = (...p: string[]): string => readFileSync(join(scores, ...p), "utf8");

// The shared MadNLP-arm telemetry markers — both vetted score templates carry
// the same dual-channel construction (mirrors Piccolo 2.2's own specs/run.jl
// and DTO 0.11's `_MadNLPCallbackAdapter` mode filter).
const MADNLP_ARM_MARKERS = [
  "import MadNLP", // the gate's import scan must admit it (support set, #1676)
  "MadNLP.AbstractUserCallback", // raw user callback — the rich-state channel
  "MadNLP.UserCallbackRegular", // the mode filter: main IPM loop only
  "MadNLP.get_cnt", // iteration counter (cnt.k)
  "MadNLP.get_obj_val", // the f= column
  "MadNLP.get_inf_pr", // the inf_pr= column
  "MadNLP.get_inf_du", // the inf_du= column
  "MadNLP.variable", // solver.x → the full NLP primal for the (primal, iter) delegate
  "MadNLP.RelaxBound", // raw callbacks manage their own fixed-variable treatment
];

describe("vetted templates on the MadNLP-default solve surface (#1676)", () => {
  describe("pulse-designer templates/solve.jl", () => {
    const T = read("pulse-designer", "templates", "solve.jl");

    it("SOLVER FILL-IN: :default (MadNLP — the DTO 0.11 default) first; :ipopt and :altissimo selectable", () => {
      expect(T).toMatch(/SOLVER\s*=\s*:default/);
      expect(T).not.toMatch(/SOLVER\s*=\s*:ipopt\b/); // no longer the default
      expect(T).toMatch(/:default \(MadNLP[^)]*\), :ipopt, or :altissimo/);
    });

    it("the 60-iter budget is audit-safe and stays (DTO #155: QualityFunctionUpdate eliminates the stall)", () => {
      expect(T).toMatch(/max_iter\s*=\s*60/);
    });

    it("the default arm is solver-agnostic: no options struct — the emitter + RelaxBound ride solve! kwargs", () => {
      expect(T).toContain(
        "solve!(qcp; max_iter = max_iter, print_level = 0,\n" +
          "           intermediate_callback = IterEmitCallbackMadNLP(pulse_emit),\n" +
          "           fixed_variable_treatment = MadNLP.RelaxBound)",
      );
    });

    it("carries the MadNLP-arm telemetry construction (all 9 markers)", () => {
      for (const m of MADNLP_ARM_MARKERS) expect(T, `solve.jl must carry ${m}`).toContain(m);
    });

    it("Ipopt remains the documented selectable path (IpoptOptions + the raw callback channel)", () => {
      expect(T).toContain("elseif SOLVER === :ipopt");
      expect(T).toContain("IpoptOptions(intermediate_callback = pulse_emit)");
      expect(T).toContain("callback = CB.callback_factory(cb_log)");
      // the raw channel's factory home is DirectTrajOpt.Callbacks since DTO 0.10
      expect(T).toContain("DirectTrajOpt.Callbacks");
      expect(T).not.toContain("Piccolo.Callbacks"); // the pre-0.10 re-home is gone
    });

    it("the version probe requires the MadNLP default (refuses pre-0.11 stacks loudly)", () => {
      expect(T).toContain("_get_DefaultSolverOptions()");
      expect(T).toMatch(/requires Piccolo ≥ 2\.2/);
    });
  });

  describe("pasqal-mis templates/solve.jl", () => {
    const T = read("pasqal-mis", "templates", "solve.jl");

    it("rides the MadNLP default through solver-agnostic kwargs (no options struct)", () => {
      expect(T).toContain(
        "solve!(qcp; max_iter = max_iter, eval_hessian = false, print_level = 0,\n" +
          "       intermediate_callback = IterEmitCallbackMadNLP(pulse_emit),\n" +
          "       fixed_variable_treatment = MadNLP.RelaxBound)",
      );
      expect(T).not.toContain("IpoptOptions"); // the single solve call rides the default
    });

    it("carries the MadNLP-arm telemetry construction (all 9 markers)", () => {
      for (const m of MADNLP_ARM_MARKERS) expect(T, `solve.jl must carry ${m}`).toContain(m);
    });

    it("drops the dead pre-0.10 re-home (Piccolo.Callbacks) — the raw channel moved to DirectTrajOpt.Callbacks", () => {
      expect(T).not.toContain("Piccolo.Callbacks");
    });
  });
});
