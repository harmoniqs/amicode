import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS = readFileSync(join(__dirname, "..", "AGENTS.md"), "utf8");

describe("AGENTS.md teaches the D9/D10 script-authoring workflow", () => {
  it("teaches the tiered resolve → author → --spec launch (spec C), not a single bundled template", () => {
    expect(AGENTS).toMatch(/\{\{AMICO_RUN\}\} resolve/); // tier resolution step (placeholder, substituted at prep)
    expect(AGENTS).toMatch(/\{\{AMICO_RUN\}\} --spec/); // the gated invocation it teaches
    expect(AGENTS).toMatch(/solve\.jl/);
    expect(AGENTS).toMatch(/vetted/); // the three tiers named
    expect(AGENTS).toMatch(/composed/);
    expect(AGENTS).toMatch(/free/);
  });
  it("authors into the workspace-owned solve.jl (spec A), never /tmp", () => {
    expect(AGENTS).toMatch(/~\/\.amico\/problems\/<slug>\/solve\.jl/); // workspace-owned
    expect(AGENTS).not.toMatch(/\/tmp\/amicode-work/); // the old scratch path is gone
    expect(AGENTS).not.toMatch(/in this project dir/);
  });
  it("teaches the portable detached launch (nohup + & in a subshell + watch inspector), not setsid", () => {
    expect(AGENTS).toMatch(/nohup/);
    expect(AGENTS).toMatch(/&\s*\)/); // backgrounded inside a subshell
    expect(AGENTS).toMatch(/Run Inspector/);
    expect(AGENTS).not.toMatch(/setsid/); // Linux-only; would silently break the macOS demo
  });
  it("does not tell the agent to block on the solve", () => {
    expect(AGENTS).not.toMatch(/wait for (the )?solve to finish/i);
  });
  it("author-first: multi-qubit transmon ROUTES to the free-tier offer (unvetted, verified), never a flat decline", () => {
    expect(AGENTS).toMatch(/single[- ]qubit/i);
    expect(AGENTS).toMatch(/multi-qubit|two-qubit|2-qubit|CNOT/i);
    // spec-20260704-113005 §5: "no template → decline" is retired — it routes to
    // the free-tier offer with an honest unvetted caveat, not a stop.
    expect(AGENTS).toMatch(/free[- ]tier/i);
    expect(AGENTS).toMatch(/unvetted/i);
    expect(AGENTS).not.toMatch(/say so plainly and stop/i);
    // the reconciliation: 2-qubit Rydberg CZ IS supported (composed exemplar / Piccolissimo path).
    // whitespace-tolerant: markdown reflow may wrap any gap in the phrase.
    expect(AGENTS).toMatch(/Rydberg\s+CZ\s+is\s+the\s+exception/i);
  });
  it("author-first PLATFORM intake: no coercion, records the actual platform, offers free-tier (spec §5)", () => {
    expect(AGENTS).toMatch(/as stated/i); // acknowledge the platform as itself
    expect(AGENTS).toMatch(/actual platform string/i); // record the real string, not "other"
    expect(AGENTS).toMatch(/never coerce/i);
    expect(AGENTS).toMatch(/## Skill index/); // routing keys off the dual-source index
    expect(AGENTS).toMatch(/free-phase CZ path/i); // the issimo Piccolissimo recommendation
  });
  it("gives regime guidance (level cap + scale N with gate time)", () => {
    expect(AGENTS).toMatch(/levels/i);
    expect(AGENTS).toMatch(/steps\/ns|timesteps/i);
  });
  it("documents the run-dir contract the script must emit", () => {
    expect(AGENTS).toMatch(/AMICODE_ITER/);
    expect(AGENTS).toMatch(/iter_.*\.png/);
    expect(AGENTS).toMatch(/result\.toml/);
    expect(AGENTS).toMatch(/load_traj/); // corrected warm-start idiom (not load_pulse)
  });
  it("does NOT teach the deleted pre-D9 flag CLI", () => {
    expect(AGENTS).not.toMatch(/--gate\b/);
    expect(AGENTS).not.toMatch(/--system\b/);
    expect(AGENTS).not.toMatch(/load_pulse/);
  });
  it("teaches the Formulation → Piccolo authoring map (typed facets)", () => {
    expect(AGENTS).toMatch(/Formulation authoring map/);
    expect(AGENTS).toMatch(/MinimumTimeProblem/);
    expect(AGENTS).toMatch(/SamplingProblem/);
    expect(AGENTS).toMatch(/trajectory_type/);
    expect(AGENTS).toMatch(/free_phase = true/);
    expect(AGENTS).toMatch(/primary infidelity objective is derived/i);
  });
});

describe("AGENTS.md teaches the Δ10 (#63) routing UX", () => {
  it("runs amico-run estimate at solve-assembly and surfaces the estimate at the decision point", () => {
    expect(AGENTS).toMatch(/\{\{AMICO_RUN\}\} estimate/);
    expect(AGENTS).toMatch(/sizeClass/);
    expect(AGENTS).toMatch(/offloadSuggested/);
    expect(AGENTS).toMatch(/local RAM/i);
  });
  it("where a solve runs follows the SELECTED SOLVER — default local, agent never routes to a cloud", () => {
    expect(AGENTS).toMatch(/selected solver/i);
    expect(AGENTS).toMatch(/default to local/i);
    expect(AGENTS).toMatch(/never routes a solve/i);
  });
  // The injected `## Routing` section is the ONLY thing that turns a solve
  // remote. Its presence must be authoritative: when a cloud-only solver is
  // selected, the base file's local default has to yield, or the agent gets two
  // conflicting instructions and dispatches HP locally (2026-07-20).
  it("the injected Routing section OVERRIDES the local default, with no routing question", () => {
    expect(AGENTS).toMatch(/OVERRIDES/);
    expect(AGENTS).toMatch(/cloud-only solver/i);
    expect(AGENTS).toMatch(/do \*\*not\*\* ask where the solve should run/i);
  });
  it("absent Routing section → the solve is local and remote is never offered", () => {
    expect(AGENTS).toMatch(/absent\*\*.*this solve is LOCAL|this solve is LOCAL/i);
    expect(AGENTS).toMatch(/do NOT offer remote/);
  });
  it("sets executor from the Routing section's presence, not from a guess", () => {
    expect(AGENTS).toMatch(/executor.*"remote"/);
    expect(AGENTS).toMatch(/executor.*"local"/);
  });
  it("entering a cloud key never routes a solve (7/19 design note)", () => {
    expect(AGENTS).toMatch(/key.*never routes a solve|never routes a solve/i);
  });
});

describe("AGENTS.md pulse-designer interview (Layer 0)", () => {
  it("scopes the interview to the pulse-designer persona and never forces it on a specific ask", () => {
    expect(AGENTS).toMatch(/pulse-designer/);
    expect(AGENTS).toMatch(/skip straight to\s+the\s+workflow/i);
    expect(AGENTS).toMatch(/fast-forward/i);
  });
  it("capabilities question has a curated answer: no webfetch, no engine talk", () => {
    expect(AGENTS).toMatch(/## Answering "What can Amicode do\?"/);
    expect(AGENTS).toMatch(/never webfetch/i);
    expect(AGENTS).toMatch(/never describe the underlying engine/i);
    expect(AGENTS).toMatch(/How I work \(author-first\)/); // the curated scope statement (renamed from "Today's scope" in §5)
  });
  it("identity: Amico/Amicode, never self-describes as opencode; interview kicks off proactively on greetings", () => {
    expect(AGENTS).toMatch(/You are \*\*Amico\*\*/);
    expect(AGENTS).toMatch(/NOT "opencode"/);
    expect(AGENTS).toMatch(/never describe yourself as an interactive CLI tool/i);
    expect(AGENTS).toMatch(/\*\*proactively\*\*/i);
    expect(AGENTS).toMatch(/greeting or no specific request/i);
  });
  it("enforces one-question-at-a-time cadence", () => {
    expect(AGENTS).toMatch(/ONE question at a time/);
    expect(AGENTS).toMatch(/Never batch/i);
  });
  it("walks the stage chain in order", () => {
    const stages = [
      "PLATFORM",
      "MODEL",
      "MODE",
      "PROBLEM",
      "FORMULATION",
      "SOLVE PARAMS",
      "INSPECT",
      "HARDWARE / CALIBRATE",
    ];
    // Match the bold stage markers — bare indexOf collides on prefixes (MODE ⊂ MODEL).
    const idx = stages.map((s) => AGENTS.indexOf(`**${s}**`));
    idx.forEach((i, k) => expect(i, `stage ${stages[k]} present`).toBeGreaterThan(-1));
    for (let k = 1; k < idx.length; k++)
      expect(idx[k], `${stages[k]} after ${stages[k - 1]}`).toBeGreaterThan(idx[k - 1]);
  });
  it("shows the transmon Hamiltonian in LaTeX and is honest about the Rydberg tier", () => {
    expect(AGENTS).toContain("\\hat H/\\hbar");
    expect(AGENTS).toMatch(/rydberg/i);
    // Rydberg authoring IS wired (composed tier, experimental) — the stale
    // "not wired / transmon-only follow-up" narrative must stay gone.
    expect(AGENTS).toMatch(/composed/i);
    expect(AGENTS).toMatch(/experimental/i);
    expect(AGENTS).not.toMatch(/Rydberg solve authoring is not wired/i);
  });
  it("names the amicode_* recording tools as bookkeeping, not gates, with bash still the launch mechanism", () => {
    for (const t of [
      "amicode_ask",
      "amicode_pick_system",
      "amicode_set_model",
      "amicode_formulate",
      "amicode_solve",
      "amicode_to_hardware",
      "amicode_calibrate",
    ]) {
      expect(AGENTS).toContain(t);
    }
    expect(AGENTS).toMatch(/bookkeeping, not gates/);
    expect(AGENTS).toMatch(/they never replace the bash launch/i);
  });
  it("teaches the free-tier verification recording (amicode_verify) and untrusted-until-agree rule", () => {
    expect(AGENTS).toContain("amicode_verify");
    expect(AGENTS).toMatch(/verification\.toml/);
    expect(AGENTS).toMatch(/cannot be promoted[\s\S]*until verification/i);
  });
  it("keeps the guardrails: T-vs-N convention and no silent global co-optimization", () => {
    expect(AGENTS).toMatch(/`T` = scalar gate time/);
    expect(AGENTS).toMatch(/`N` = number of timesteps/);
    expect(AGENTS).toMatch(/Never silently\s+co-optimize/i);
  });
  it("leaves no unknown {{...}} placeholder after session-prep substitution", () => {
    const substituted = AGENTS.replace(/\{\{TEMPLATE_PATH\}\}/g, "/abs/solve_template.jl")
      .replace(/\{\{JULIA_PROJECT\}\}/g, "/abs/julia")
      .replace(/\{\{AMICO_RUN\}\}/g, "/abs/bin/amico-run");
    expect(substituted).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

// The SOLVER flag is the ONLY supported way to switch backends. Without naming it,
// an agent asked for Altissimo hand-writes a solve call and silently loses the
// frames (they come off IpoptOptions.intermediate_callback, which AltissimoOptions
// has no equivalent of) plus the iteration budget (max_iter is dropped on that
// path). The template handles all of it; the agent just has to flip the flag.
describe("HP solver-mode guidance: how to select Altissimo", () => {
  const hpSection = async (): Promise<string> => {
    const { solverModeSection } = await import("../src/opencode_config");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const prev = process.env.AMICODE_OPS_DIR;
    const dir = mkdtempSync(join(tmpdir(), "solvermode-"));
    writeFileSync(join(dir, "solver-mode.json"), JSON.stringify({ mode: "hp", status: "ready" }));
    process.env.AMICODE_OPS_DIR = dir;
    try {
      return solverModeSection();
    } finally {
      if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = prev;
    }
  };

  it("names SOLVER = :altissimo as the switch, and forbids hand-rolling the call", async () => {
    const s = await hpSection();
    expect(s).not.toBe(""); // guard: a misfiring mode gate would make these vacuous
    expect(s).toMatch(/SOLVER = :altissimo/);
    expect(s).toMatch(/Do NOT hand-roll/i);
  });

  it("states both traps a hand-rolled call would hit: lost frames and a dropped budget", async () => {
    const s = await hpSection();
    expect(s).toMatch(/intermediate_callback/);
    expect(s).toMatch(/max_outer_iter/);
    expect(s).toMatch(/silently DROPPED/);
  });
})

// A cloud solve failed with an UndefVarError at load time because the agent wrote
// `using Piccolissimo` without `using Piccolo`. Piccolissimo does not re-export
// Piccolo's symbols, and every problem-setup name (GATES, TransmonSystem,
// EmbeddedOperator, UnitaryTrajectory) lives in Piccolo. On a cloud run you pay
// the full queue + boot wait before the error surfaces, so the guidance has to be
// explicit rather than implied by the template.
describe("HP solver-mode guidance: both imports", () => {
  it("tells the agent to import Piccolo alongside Piccolissimo, and why", async () => {
    const { solverModeSection } = await import("../src/opencode_config");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const prev = process.env.AMICODE_OPS_DIR;
    const dir = mkdtempSync(join(tmpdir(), "solvermode-"));
    writeFileSync(join(dir, "solver-mode.json"), JSON.stringify({ mode: "hp", status: "ready" }));
    process.env.AMICODE_OPS_DIR = dir;
    try {
      const s = solverModeSection();
      expect(s).not.toBe(""); // guard: if the mode gate misfires the asserts below are vacuous
      expect(s).toMatch(/using Piccolo`? AND `?using Piccolissimo/);
      expect(s).toMatch(/does NOT re-export/);
      expect(s).toMatch(/GATES/);
      expect(s).toMatch(/TransmonSystem/);
    } finally {
      if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = prev;
    }
  });
});

// Perf regression guard (2026-08-03). Profiling found 128 unbounded `find` calls
// over $HOME — 417 seconds — because AGENTS.md said bare `amico-run` and the agent
// fell back to `which amico-run || find ~ -name amico-run` when PATH missed. The
// binary's absolute path is known at activation, so hand it over and remove the
// reason to search.
describe("AGENTS.md hands over the absolute amico-run path", () => {
  const prepared = async (amicoRunPath?: string): Promise<string> => {
    const { prepareOpencodeProject } = await import("../src/opencode_config");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const p = prepareOpencodeProject({
      agentsSrc: join(__dirname, "..", "AGENTS.md"),
      templateSrc: "/tmp/tmpl.jl",
      juliaProject: "/tmp/proj",
      vaultDir: "",
      projectDir: mkdtempSync(join(tmpdir(), "agents-perf-")),
      ...(amicoRunPath ? { amicoRunPath } : {}),
    });
    return readFileSync(p.agentsPath, "utf8");
  };

  it("substitutes the absolute path and leaves no placeholder behind", async () => {
    const out = await prepared("/abs/bin/amico-run");
    expect(out).toContain("/abs/bin/amico-run --spec");
    expect(out).not.toContain("{{AMICO_RUN}}");
  });

  it("degrades to the bare command when the bin dir is unknown", async () => {
    const out = await prepared(undefined);
    expect(out).toContain("amico-run --spec"); // previous behaviour, not a broken placeholder
    expect(out).not.toContain("{{AMICO_RUN}}");
  });

  it("forbids the $HOME scan and tells the agent to batch", async () => {
    const out = await prepared("/abs/bin/amico-run");
    expect(out).toMatch(/never fall back to `?find ~/);
    expect(out).toMatch(/Batch independent tool calls into one turn/);
    expect(out).toMatch(/Do \*\*not\*\* run\s+`?which amico-run/);
  });
});
