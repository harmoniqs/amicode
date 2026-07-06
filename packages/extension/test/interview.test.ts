import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildKickoffPrompt, canonicalGate, extractActivity, extractJson, fillTemplate, estimateProblem, physicsHints, platformFamily, PLATFORM_FAMILIES, templateEnvelope, INTERVIEW_STAGES, SOLVE_TEMPLATES, TEMPLATE_DELTA_DEFAULT, type InterviewSlots, type TemplateSpec } from "../src/interview_shell";
import { HAMILTONIAN_TERMS, DRIVE_LINE } from "../media/ui/components/hamiltonian_terms";
import { hamiltonianLines, isHamiltonianTerm } from "../media/ui/components/hamiltonian_terms";

// UX1 live interview (#46): the deterministic seams — the solve leg's
// template fill (no LLM in the critical path), the kickoff contract, and
// the résumé estimate.

const SLOTS: InterviewSlots = {
  modality: "transmon", system_name: "Emerald-Q3", device_source: "manual defaults",
  levels: 4, drive_max: 0.15, n_drives: 2, gate: "H",
  objective: "vetted-default", T: 12.5, N: 60, max_iter: 100,
};

describe("fillTemplate — deterministic solve leg", () => {
  const template = readFileSync(join(__dirname, "..", "templates", "solve_template.jl"), "utf8");

  it("substitutes every interview slot into the vetted template's FILL-IN block", () => {
    const out = fillTemplate(template, SLOTS);
    expect(out).toContain('system     = "transmon"');
    expect(out).toContain('gate_name  = "H"');
    expect(out).toContain("levels     = 4");
    expect(out).toContain("T          = 12.5");
    expect(out).toContain("N          = 60");
    expect(out).toContain("drive_max  = 0.15");
    expect(out).toContain("max_iter   = 100");
    // the substitution must not clobber anything outside the FILL-IN block
    expect(out).toContain("PulseEmitCallback");
    expect(out).toContain("AMICODE_PULSE_META");
  });

  it("truncates non-integer counts (levels/N/max_iter are integers in Julia)", () => {
    const out = fillTemplate(template, { ...SLOTS, N: 60.9, levels: 3.2, max_iter: 80.5 });
    expect(out).toContain("N          = 60");
    expect(out).toContain("levels     = 3");
    expect(out).toContain("max_iter   = 80");
  });

  it("normalizes a single-subsystem levels array (envelope gates multi-subsystem upstream)", () => {
    expect(fillTemplate(template, { ...SLOTS, levels: [5] })).toContain("levels     = 5");
  });

  it("canonicalizes gate case for Julia's case-sensitive GATES lookup", () => {
    expect(canonicalGate("h")).toBe("H");
    expect(canonicalGate("SQRTX")).toBe("sqrtX");
    expect(canonicalGate("sqrtX")).toBe("sqrtX");
    expect(fillTemplate(template, { ...SLOTS, gate: "h" })).toContain('gate_name  = "H"');
  });

  it("throws LOUDLY when the template drifts and a FILL-IN pattern is missing", () => {
    const drifted = template.replace(/^gate_name\s*=/m, "gatename =");
    expect(() => fillTemplate(drifted, SLOTS)).toThrow(/template drifted/);
  });

  it("substitutes the user's own δ when given; leaves the template default otherwise", () => {
    expect(fillTemplate(template, { ...SLOTS, delta: 0.34 })).toContain("δ          = 0.34");
    // no delta slot → the template's default line survives verbatim
    expect(fillTemplate(template, SLOTS)).toMatch(/^δ\s+=\s*0\.2\s/m);
  });

  it("TEMPLATE_DELTA_DEFAULT stays in sync with the template's δ line", () => {
    expect(template).toMatch(new RegExp(`^δ\\s+=\\s*${TEMPLATE_DELTA_DEFAULT}\\b`, "m"));
  });
});

describe("templateEnvelope — the one vetted template's honest limits", () => {
  it("accepts what the template models: single transmon, anharmonicity physics", () => {
    expect(templateEnvelope(SLOTS).ok).toBe(true);
    expect(templateEnvelope({ ...SLOTS, levels: [3], physics: ["anharmonicity"] }).ok).toBe(true);
  });
  it("refuses other modalities — a rydberg answer must never run TransmonSystem", () => {
    const env = templateEnvelope({ ...SLOTS, modality: "rydberg" });
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("rydberg");
  });
  it("refuses multi-subsystem levels (qubit 3 / coupler 5) and unmodeled physics", () => {
    expect(templateEnvelope({ ...SLOTS, levels: [3, 5, 3] }).ok).toBe(false);
    const env = templateEnvelope({ ...SLOTS, physics: ["anharmonicity", "ZZ crosstalk"] });
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("ZZ crosstalk");
  });
  it("refuses gates outside the vetted GATES table — CZ/custom/state-prep must not run the single-qubit template", () => {
    expect(templateEnvelope({ ...SLOTS, gate: "CZ" }).ok).toBe(false);
    const env = templateEnvelope({ ...SLOTS, gate: "custom", gate_spec: "RX(pi/7)" });
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("custom");
    expect(templateEnvelope({ ...SLOTS, gate: "state-prep", gate_spec: "|0> to |1>" }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, gate: "sqrtX" }).ok).toBe(true);
  });
  it("refuses malformed numeric slots — a bad résumé must never enable Solve", () => {
    expect(templateEnvelope({ ...SLOTS, T: "10 ns" as never }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, N: undefined as never }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, max_iter: -5 }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, levels: 1 }).ok).toBe(false);        // a 1-level "qubit" is nonsense
    expect(templateEnvelope({ ...SLOTS, levels: [] as never }).ok).toBe(false);
  });
  it("refuses a non-physical δ — negative lab-convention values must not build an inverted Hamiltonian", () => {
    expect(templateEnvelope({ ...SLOTS, delta: -0.2 }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, delta: "0.2" as never }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, delta: 0.34 }).ok).toBe(true);
    expect(templateEnvelope(SLOTS).ok).toBe(true);   // absent stays fine (template default)
  });
  it("refuses non-default frame/modulation/bounds; device_limits stay informational", () => {
    expect(templateEnvelope({ ...SLOTS, frame: "lab frame" }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, frame: "qubit-rotating (RWA)" }).ok).toBe(true);
    expect(templateEnvelope({ ...SLOTS, modulation: "sideband at 200 MHz" }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, bounds: "slew rate < 0.1 GHz/ns" }).ok).toBe(false);
    expect(templateEnvelope({ ...SLOTS, device_limits: ["T2 = 80 us", "AWG 2 GS/s"] }).ok).toBe(true);
  });
});

// The registry refactor's contract: adding a modality = a new TemplateSpec
// entry (+ its .jl template + schema branch), ZERO interview-code changes.
// Proven here with a synthetic rydberg spec injected as registry data.
describe("solve-template registry — adding a modality is content, not code", () => {
  const RYDBERG_TEST: TemplateSpec = {
    id: "rydberg-cz-test",
    label: "rydberg pair (global drive)",
    templateFile: "rydberg_template.jl",
    modality: /rydberg/i,
    // Dark |0⟩ in the 3-level model: entangling gates ONLY — a rydberg entry
    // must never offer 1Q gates (the vault's loudest rydberg gotcha).
    gates: /^CZ$/i,
    gatesLabel: "CZ",
    maxSubsystems: 2,
    physics: /blockade|rydberg/i,
    frame: /rotating|default/i,
    frameLabel: "the rotating frame",
    modulation: /global|default/i,
    modulationLabel: "a global drive",
    supportsBounds: false,
    fill: [{ pattern: /^T\s*=\s*[\d.]+/m, value: (s) => `T = ${s.T}` }],
  };
  const registry = [...SOLVE_TEMPLATES, RYDBERG_TEST];
  const rydberg: InterviewSlots = { ...SLOTS, modality: "rydberg", gate: "CZ", levels: [3, 3], physics: ["Rydberg blockade"] };

  it("reports WHICH vetted template a solvable config will run", () => {
    expect(templateEnvelope(SLOTS).template?.id).toBe("transmon-1q");
  });
  it("a new registry entry makes its modality solvable — no interview-code change", () => {
    const env = templateEnvelope(rydberg, registry);
    expect(env.ok).toBe(true);
    expect(env.template?.id).toBe("rydberg-cz-test");
    // the shipped registry (no rydberg entry) still refuses the same config honestly
    expect(templateEnvelope(rydberg).ok).toBe(false);
  });
  it("enforces the family's own gate law (dark |0⟩ → entangling gates only)", () => {
    const env = templateEnvelope({ ...rydberg, gate: "X" }, registry);
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("CZ");
  });
  it("an unmatched modality names what IS vetted", () => {
    const env = templateEnvelope({ ...SLOTS, modality: "bosonic" }, registry);
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("single transmon");
    expect(env.reason).toContain("rydberg pair");
  });
  it("fillTemplate substitutes per the matched spec's own FILL-IN patterns", () => {
    expect(fillTemplate("T          = 10.0\n", rydberg, RYDBERG_TEST)).toContain("T = 12.5");
    expect(() => fillTemplate("no fill-in block here", rydberg, RYDBERG_TEST)).toThrow(/template drifted/);
  });
});

// Every platform is a PATH: the family registry carries where each family's
// physics lives (demo repos), its warm-start doctrine, and catalog seeds.
describe("platform families — all platforms are interview paths", () => {
  it("covers the demo-repo family (transmon vetted; the rest name their repo)", () => {
    const labels = PLATFORM_FAMILIES.map((f) => f.label);
    for (const l of ["transmon", "rydberg / neutral atom", "fluxonium", "trapped ion", "bosonic / cavity", "NV center", "spin qubit"]) {
      expect(labels).toContain(l);
    }
    expect(PLATFORM_FAMILIES.find((f) => f.label === "transmon")?.status).toBe("vetted");
    for (const f of PLATFORM_FAMILIES.filter((f) => f.status === "demo")) {
      expect(f.demoRepo, `${f.label} needs a demoRepo`).toMatch(/^harmoniqs\//);
    }
  });
  it("routes modality synonyms to their family", () => {
    expect(platformFamily("neutral atom")?.label).toBe("rydberg / neutral atom");
    expect(platformFamily("rydberg")?.warmStarts?.some((w) => w.id === "rydberg-CZ-quera-v1")).toBe(true);
    expect(platformFamily("cavity QED")?.label).toBe("bosonic / cavity");
  });
  it("encodes the per-platform warm-start doctrine (fluxonium is COLD-ONLY)", () => {
    expect(platformFamily("fluxonium")?.warmStartPolicy).toMatch(/COLD START ONLY/);
    expect(platformFamily("rydberg")?.warmStartPolicy).toMatch(/J-P/);
  });
  it("an unmatched-family refusal is a path, not a dead end", () => {
    const env = templateEnvelope({ ...SLOTS, modality: "rydberg" });
    expect(env.ok).toBe(false);
    expect(env.reason).toContain("harmoniqs/atoms-demo");
    expect(env.reason).toContain("rydberg-CZ-quera-v1");
  });
});

describe("hamiltonian terms — LaTeX surface for the KaTeX panel", () => {
  it("every registry term and the drive line carry LaTeX", () => {
    for (const t of HAMILTONIAN_TERMS) expect(t.latex, t.math).toMatch(/\\/);
    expect(DRIVE_LINE.latex).toContain("u_1(t)");
  });
  it("unknown labels are TeX-sanitized, never dropped", () => {
    const l = hamiltonianLines(["charge dispersion {x} \\evil$"]).find((x) => x.latex.includes("\\text"));
    expect(l).toBeDefined();
    expect(l?.latex).toContain("charge dispersion");
    expect(l?.latex).not.toContain("\\evil");
    expect(l?.latex).not.toContain("$");
  });
});

describe("buildKickoffPrompt — the interview contract", () => {
  const prompt = buildKickoffPrompt();

  it("carries every stage with its id as the question header contract", () => {
    for (const s of INTERVIEW_STAGES) {
      expect(prompt).toContain(s.title);
      expect(prompt).toContain(`header: "${s.id}"`);
    }
  });
  it("forbids agent-authored Other options — the composer IS the free-form path", () => {
    expect(prompt).toMatch(/NEVER include an "Other"/);
    expect(prompt).toMatch(/chat input below the options is always available/);
  });
  it("pins the load-bearing protocol rules: question TOOL for questions, strict JSON for the resume", () => {
    expect(prompt).toContain("QUESTION TOOL");
    expect(prompt).toContain("Never ask questions as plain text");
    expect(prompt).toContain("ONE question at a time");
    expect(prompt).toContain("EXACTLY ONE JSON text object");
    expect(prompt).toContain('"type":"resume"');
    expect(prompt).toMatch(/do NOT run anything/i);
  });
  it("carries the physics slot, per-subsystem levels, faithful capture, and revision rules", () => {
    expect(prompt).toContain("physics");
    expect(prompt).toContain("per subsystem");
    expect(prompt).toMatch(/FAITHFULLY/);
    expect(prompt).toMatch(/revise any earlier answer/i);
  });
  it("pins fidelity-first staging: advanced goals warm-start from the baseline, never fold in", () => {
    expect(prompt).toContain("followups");
    expect(prompt).toMatch(/FIDELITY-FIRST/);
    expect(prompt).toMatch(/warm-start from the baseline/);
    expect(prompt).toContain("PRIMARY resolution knob");
    expect(prompt).toContain("free-time baseline");   // min-time composition (Piccolo quickstart)
  });
  it("recognizes state preparation as a distinct target type", () => {
    expect(prompt).toContain('"state-prep"');
    expect(prompt).toContain("state preparation");
  });
  it("carries the researcher-feedback slots: custom gates, bounds, device limits, frame/modulation", () => {
    expect(prompt).toContain('"gate":"custom"');
    expect(prompt).toContain("gate_spec");
    expect(prompt).toContain("device_limits");
    expect(prompt).toContain("frame");
    expect(prompt).toContain("modulation");
    expect(prompt).toContain("bounds");
    expect(prompt).toMatch(/offer the default and move on/i);
  });
  it("carries the physicist device-identity slot (δ) and the virtual-Z aside", () => {
    expect(prompt).toContain("anharmonicity δ");
    expect(prompt).toMatch(/POSITIVE convention/);
    expect(prompt).toContain("virtual-Z");
  });
  it("carries the PLATFORM PATHS table: every family, its repo, its doctrine", () => {
    expect(prompt).toContain("PLATFORM PATHS");
    expect(prompt).toContain("harmoniqs/atoms-demo");
    expect(prompt).toContain("harmoniqs/fluxonium-demo");
    expect(prompt).toMatch(/NEVER suggest warm starts for fluxonium/);
    expect(prompt).toContain("rydberg-CZ-quera-v1");
  });
  it("pins physics as ONE multi-select question of individual terms (live-Hamiltonian contract)", () => {
    expect(prompt).toContain("ONE question at a time");
    expect(prompt).toMatch(/multi-select question \(set multiple: true\)/);
    expect(prompt).toMatch(/live Hamiltonian/);
    expect(prompt).toMatch(/never bundle/i);   // one term per option — the panel toggles term-by-term
  });
});

describe("hamiltonianLines — the live Ĥ(t) assembling from toggled physics terms", () => {
  it("recognizes the transmon term vocabulary; arbitrary labels are not terms", () => {
    for (const l of ["anharmonicity", "ZZ crosstalk", "tunable coupler", "T1/T2 decoherence"]) {
      expect(isHamiltonianTerm(l), l).toBe(true);
    }
    expect(isHamiltonianTerm("Emerald-Q3")).toBe(false);
  });
  it("always carries the I/Q drive line — a gate problem drives the qubit", () => {
    expect(hamiltonianLines([]).some((l) => l.math.includes("u₁(t)"))).toBe(true);
  });
  it("orders drift first, drives second, interactions after", () => {
    const lines = hamiltonianLines(["ZZ crosstalk", "anharmonicity"]);
    expect(lines[0].math).toContain("δ⁄2");        // drift leads even when selected later
    expect(lines[1].math).toContain("u₁(t)");
    expect(lines[2].math).toContain("ζ");
  });
  it("routes decoherence to the Lindbladian, never into Ĥ", () => {
    const l = hamiltonianLines(["T1/T2 decoherence"]).find((l) => l.lindblad);
    expect(l?.math).toContain("𝓛");
    expect(l?.note).toContain("not Ĥ");
  });
  it("never drops unrecognized physics — captured as an agent-interpreted term", () => {
    const l = hamiltonianLines(["charge dispersion"]).find((l) => l.math.includes("charge dispersion"));
    expect(l?.note).toContain("Amico will interpret");
  });
  it("ignores none-of-these style answers", () => {
    expect(hamiltonianLines(["none beyond the default"])).toHaveLength(1);   // just the drive line
  });
});

describe("physicsHints — physicist sanity advice on the résumé (soft, never blocking)", () => {
  it("stays silent for the well-posed default problem", () => {
    expect(physicsHints({ ...SLOTS, gate: "X", T: 10, N: 50, drive_max: 0.2 })).toEqual([]);
  });
  it("flags an under-driven π-class gate (T·drive_max too small to rotate)", () => {
    const hints = physicsHints({ ...SLOTS, gate: "X", T: 2, N: 50, drive_max: 0.05 });
    expect(hints.some((h) => h.includes("under-driven"))).toBe(true);
    // Z-class targets don't need a π of drive area — no under-driven nag
    expect(physicsHints({ ...SLOTS, gate: "Z", T: 2, N: 50, drive_max: 0.05 }).some((h) => h.includes("under-driven"))).toBe(false);
  });
  it("flags the fast-gate leakage regime (T inside ~1/δ), honoring the user's own δ", () => {
    expect(physicsHints({ ...SLOTS, T: 4, N: 50, drive_max: 0.3 }).some((h) => h.includes("leakage"))).toBe(true);
    // a stiffer transmon (bigger δ) makes the same T safe
    expect(physicsHints({ ...SLOTS, T: 4, N: 50, drive_max: 0.3, delta: 0.5 }).some((h) => h.includes("leakage"))).toBe(false);
  });
  it("flags a control grid too coarse to resolve the anharmonic dynamics", () => {
    expect(physicsHints({ ...SLOTS, T: 50, N: 10, drive_max: 0.2 }).some((h) => h.includes("coarse control grid"))).toBe(true);
  });
  it("never throws on malformed numerics (envelope handles blocking)", () => {
    expect(physicsHints({ ...SLOTS, T: "10" as never })).toEqual([]);
  });
});

describe("extractActivity — honest turn-activity surfacing", () => {
  const msg = (parts: Array<Record<string, unknown>>) => [
    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { role: "assistant" }, parts },
  ];
  it("surfaces the newest tool call + referenced files (state.input shape)", () => {
    const a = extractActivity(msg([
      { type: "tool", tool: "read", state: { input: { filePath: "/ext/AGENTS.md" } } },
      { type: "tool", tool: "read", state: { input: { filePath: "/ext/templates/solve_template.jl" } } },
    ]));
    expect(a.label).toBe("read · solve_template.jl");
    expect(a.files).toEqual(["AGENTS.md", "solve_template.jl"]);
  });
  it("tolerates the args/input bag variants", () => {
    expect(extractActivity(msg([{ type: "tool-invocation", name: "grep", args: { path: "src/x.ts" } }])).label).toBe("grep · x.ts");
    expect(extractActivity(msg([{ type: "tool", tool: "bash", input: { command: "ls -la  " } }])).label).toBe("bash");
  });
  it("the question tool is protocol, not activity — filtered out", () => {
    // Evidence (live session log): "question" is the ONLY tool today's
    // interview agent calls; surfacing it would just announce the question.
    const a = extractActivity(msg([{ type: "tool", tool: "question", state: { input: { header: "target" } } }]));
    expect(a.label).toBeUndefined();
  });
  it("no tool parts → no label, never invented", () => {
    const a = extractActivity(msg([{ type: "text", text: "thinking about transmons" }]));
    expect(a.label).toBeUndefined();
    expect(a.files).toEqual([]);
  });
  it("survives garbage shapes", () => {
    expect(() => extractActivity(null)).not.toThrow();
    expect(() => extractActivity([{ parts: "nope" }])).not.toThrow();
    expect(extractActivity(undefined).files).toEqual([]);
  });
});

describe("extractJson — the reply parser", () => {
  it("parses a bare protocol object", () => {
    expect(extractJson('{"type":"question","question":"?"}')).toEqual({ type: "question", question: "?" });
  });
  it("tolerates code fences and surrounding prose", () => {
    expect(extractJson('Sure!\n```json\n{"type":"resume","slots":{"gate":"X"}}\n```')).toEqual({ type: "resume", slots: { gate: "X" } });
  });
  it("returns undefined on non-JSON replies (drives the re-ask)", () => {
    expect(extractJson("What system are you working with?")).toBeUndefined();
  });
});

describe("estimateProblem — résumé numbers", () => {
  it("scales with N and levels and buckets the wall-time estimate", () => {
    const small = estimateProblem({ ...SLOTS, levels: 3, N: 50 });
    const big = estimateProblem({ ...SLOTS, levels: 5, N: 200 });
    expect(big.vars).toBeGreaterThan(small.vars);
    expect(small.estMinutes).toBe("2–3 min");
    expect(["5–10 min", "10+ min"]).toContain(big.estMinutes);
  });
  it("treats array levels as a composite Hilbert space (dim = product)", () => {
    const composite = estimateProblem({ ...SLOTS, levels: [3, 5], N: 50 });
    const dim15 = estimateProblem({ ...SLOTS, levels: 15, N: 50 });
    expect(composite.vars).toBe(dim15.vars);
  });
  it("buckets a coarse memory estimate alongside time", () => {
    expect(estimateProblem({ ...SLOTS, levels: 3, N: 50 }).estMemory).toBe("<1 GB");
    expect(estimateProblem({ ...SLOTS, levels: [3, 5], N: 200 }).estMemory).toBe("8+ GB");
  });
});
