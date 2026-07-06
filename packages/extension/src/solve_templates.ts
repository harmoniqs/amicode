// Solve-template registry (#46) — the solve leg's knowledge, as data.
//
// The interview captures ANY modality faithfully; what's solvable is decided
// here, deterministically (no LLM in the critical path). Each vetted template
// is one registry entry declaring what it HONESTLY models: the modality, the
// gate set, the levels shape, the physics terms, and how its FILL-IN block is
// substituted. Adding a modality (rydberg CZ, qubit+coupler transmon, …) is a
// content change — a new .jl template + a new entry (+ its formulation.toml
// schema branch, per #81's landing pattern) — and touches ZERO interview code.
//
// "Vetted" is a physicist's signature, not a vibe: an entry must only declare
// physics its template actually implements (rydberg's dark |0⟩ means a rydberg
// entry must refuse 1Q gates; fluxonium's warm-start regression means its
// entry ships cold-start policy). The registry is the honesty gate — it never
// guesses, and an unmatched configuration returns a nameable reason instead.

// ---------------------------------------------------------------------------
// Slots — the interview's résumé contract (owned here so the registry is
// self-contained; interview_shell re-exports for its callers/tests).
// ---------------------------------------------------------------------------

export interface InterviewSlots {
  modality: string;
  system_name?: string;
  device_source?: string;
  /** Hamiltonian terms/effects the model includes (e.g. ["anharmonicity"]). */
  physics?: string[];
  /** Hardware constraints (T1/T2, AWG bandwidth…) — informational, never blocking. */
  device_limits?: string[];
  /** Per-subsystem: scalar for a single qubit, array for qubit+coupler models. */
  levels: number | number[];
  /** Transmon anharmonicity δ (GHz, positive convention); absent = template default. */
  delta?: number;
  drive_max: number;
  n_drives?: number;
  /** Rotating-frame choice; absent = the template's default (qubit frame, RWA). */
  frame?: string;
  /** Modulation scheme; absent = the template's default (baseband I/Q on resonance). */
  modulation?: string;
  /** Bounds beyond the symmetric per-quadrature cap (asymmetric, slew-rate…). */
  bounds?: string;
  gate: string;
  /** Verbatim description when gate === "custom". */
  gate_spec?: string;
  objective: string;
  /** Stages composed AFTER the baseline via warm-start (min-time, robustness,
   *  leakage suppression) — captured intent, never part of the first solve. */
  followups?: string[];
  T: number;
  N: number;
  max_iter: number;
}

/** Canonical Piccolo GATES key for a vetted gate answer — "h" → "H",
 *  "SQRTX" → "sqrtX". Julia symbol lookup is case-sensitive even though
 *  matching accepts any case. Pure; exported for tests. */
export function canonicalGate(gate: string): string {
  return /^sqrtx$/i.test(gate) ? "sqrtX" : gate.toUpperCase();
}

// ---------------------------------------------------------------------------
// TemplateSpec — one vetted template's declaration.
// ---------------------------------------------------------------------------

export interface TemplateSpec {
  /** Registry id, shown on the résumé (e.g. "transmon-1q"). */
  id: string;
  /** Human label used in refusal messages (e.g. "single transmon"). */
  label: string;
  /** Template filename under the extension's templates/ dir. */
  templateFile: string;
  /** Which modality answers this template serves. */
  modality: RegExp;
  /** The vetted gate set. */
  gates: RegExp;
  /** Refusal text naming the gate set (kept human, not derived from the regex). */
  gatesLabel: string;
  /** How many subsystems the model supports (levels array length). */
  maxSubsystems: number;
  /** Physics terms the template models — anything else is an honest refusal.
   *  (default/none-style answers are always allowed through.) */
  physics: RegExp;
  /** Accepted frame answers beyond "absent = default". */
  frame: RegExp;
  frameLabel: string;
  /** Accepted modulation answers beyond "absent = default". */
  modulation: RegExp;
  modulationLabel: string;
  /** Whether richer bounds (asymmetric, slew-rate) are modeled. */
  supportsBounds: boolean;
  /** Per-template parameter validation (e.g. transmon δ > 0). */
  paramCheck?: (slots: InterviewSlots) => string | undefined;
  /** FILL-IN substitutions: pattern → replacement (undefined = leave the
   *  template's own default line untouched). fillTemplate throws LOUDLY when
   *  a pattern is missing — template drift must never silently run defaults. */
  fill: Array<{ pattern: RegExp; value: (slots: InterviewSlots) => string | undefined }>;
  /** Physicist sanity hints for the résumé — soft advice, never blockers. */
  hints?: (slots: InterviewSlots) => string[];
}

// ---------------------------------------------------------------------------
// transmon-1q — the first vetted template (P6 ✓, single transmon, qubit-
// rotating frame + RWA, baseband I/Q on resonance, anharmonicity physics).
// ---------------------------------------------------------------------------

/** The vetted template's built-in anharmonicity — what actually runs when the
 *  user didn't supply their own δ. Kept in sync with solve_template.jl by the
 *  template-drift test. */
export const TEMPLATE_DELTA_DEFAULT = 0.2;

/** Physicist sanity hints (transmon). Pure; exported for tests. */
export function physicsHints(slots: InterviewSlots): string[] {
  const hints: string[] = [];
  const δ = slots.delta ?? TEMPLATE_DELTA_DEFAULT;
  const { T, N, drive_max } = slots;
  if (![T, N, drive_max].every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return hints;
  // Drive area: a π rotation needs ∫Ω dt on the order of a half Rabi cycle.
  // T·drive_max ≪ that and the optimizer has nothing to work with — the classic
  // "why is it stagnating" trap for π-class gates (X/Y/H/sqrtX).
  if (/^(X|Y|H|sqrtX)$/i.test(slots.gate) && T * drive_max < 0.5) {
    hints.push(`under-driven: T·drive_max = ${(T * drive_max).toFixed(2)} GHz·ns — likely too little drive area for a π-class rotation; expect stagnation. Increase T or drive_max.`);
  }
  // Leakage regime: gate times inside ~1/δ can't spectrally avoid the |1⟩→|2⟩
  // transition — fidelity caps out unless levels/DRAG-like shaping absorb it.
  if (T * δ < 1) {
    hints.push(`fast-gate regime: T = ${T} ns is inside ~1/δ (${(1 / δ).toFixed(1)} ns at δ = ${δ} GHz) — leakage will limit fidelity; consider a longer T or more levels for realism.`);
  }
  // Control resolution: fewer than ~2 knots per 1/δ undersamples the very
  // dynamics the anharmonicity introduces.
  if (T / N > 0.5 / δ) {
    hints.push(`coarse control grid: dt = ${(T / N).toFixed(2)} ns exceeds ~1/(2δ) — raise N (the primary resolution knob) to resolve the anharmonic dynamics.`);
  }
  return hints;
}

export const TRANSMON_1Q: TemplateSpec = {
  id: "transmon-1q",
  label: "single transmon",
  templateFile: "solve_template.jl",
  modality: /transmon/i,
  gates: /^(X|Y|Z|H|S|T|sqrtX)$/i,
  gatesLabel: "X/Y/Z/H/S/T/sqrtX",
  maxSubsystems: 1,
  physics: /anharmonicity/i,
  frame: /rotating|rwa|default/i,
  frameLabel: "the qubit-rotating frame (RWA)",
  modulation: /baseband|resonance|i\/?q|default/i,
  modulationLabel: "baseband I/Q on resonance",
  supportsBounds: false,
  paramCheck: (slots) => {
    // δ is optional, but a supplied one must be physical: the template documents
    // the POSITIVE convention, so a lab-convention negative δ must bounce here
    // rather than silently build an inverted Hamiltonian.
    if (slots.delta !== undefined && (typeof slots.delta !== "number" || !Number.isFinite(slots.delta) || slots.delta <= 0)) {
      return `"delta" must be a positive number in GHz (positive convention — e.g. 0.2 for -200 MHz lab anharmonicity)`;
    }
    return undefined;
  },
  fill: [
    { pattern: /^system\s*=\s*"[^"]*"/m, value: (s) => `system     = ${JSON.stringify(s.modality)}` },
    { pattern: /^gate_name\s*=\s*"[^"]*"/m, value: (s) => `gate_name  = ${JSON.stringify(canonicalGate(s.gate))}` },
    // δ: the user's own anharmonicity when they gave one (a real device's pulse
    // must be solved against THAT device's δ); template default otherwise.
    { pattern: /^δ\s*=\s*[\d.]+/m, value: (s) => (s.delta !== undefined ? `δ          = ${s.delta}` : undefined) },
    // Scalar by construction: matchTemplate gates the solve leg to
    // single-subsystem configs before fillTemplate ever runs.
    { pattern: /^levels\s*=\s*\d+/m, value: (s) => `levels     = ${Math.trunc(Array.isArray(s.levels) ? s.levels[0] : s.levels)}` },
    { pattern: /^T\s*=\s*[\d.]+/m, value: (s) => `T          = ${s.T}` },
    { pattern: /^N\s*=\s*\d+/m, value: (s) => `N          = ${Math.trunc(s.N)}` },
    { pattern: /^drive_max\s*=\s*[\d.]+/m, value: (s) => `drive_max  = ${s.drive_max}` },
    { pattern: /^max_iter\s*=\s*\d+/m, value: (s) => `max_iter   = ${Math.trunc(s.max_iter)}` },
  ],
  hints: physicsHints,
};

/** The vetted registry. Rydberg CZ (+ Pasqal profile) and multi-subsystem
 *  transmon land here as entries — each in the same PR as its template and
 *  formulation.toml schema branch (#81 pattern), physicist-vetted. */
export const SOLVE_TEMPLATES: TemplateSpec[] = [TRANSMON_1Q];

// ---------------------------------------------------------------------------
// Platform families — every platform is a PATH in the interview, whether or
// not its amicode template has landed. Data from the harmoniqs demo-repo
// family (harmoniqs/<system>-demo, per the demo skill's canonical layout),
// the team catalog (armonissima catalog/pulses/), and the vault's warm-start
// doctrine. The interview offers ALL of these as modality options; the
// envelope stays honest about which solve in-extension TODAY, and a refusal
// names where the physics already lives instead of a dead end.
// ---------------------------------------------------------------------------

export interface PlatformFamily {
  /** Modality answers this family covers. */
  match: RegExp;
  label: string;
  /** "vetted" = a SOLVE_TEMPLATES entry runs it here; "demo" = the solve
   *  exists in a harmoniqs demo repo but isn't wrapped for amicode yet. */
  status: "vetted" | "demo";
  /** Where the working solve scripts live (demo-repo name). */
  demoRepo?: string;
  /** The vault's warm-start doctrine for this family — per-platform, and
   *  load-bearing (fluxonium warm starts REGRESS; rydberg baselines from J-P). */
  warmStartPolicy?: string;
  /** Known catalog seeds (armonissima catalog/pulses/) usable as warm starts. */
  warmStarts?: Array<{ id: string; note: string }>;
}

export const PLATFORM_FAMILIES: PlatformFamily[] = [
  {
    match: /transmon/i,
    label: "transmon",
    status: "vetted",
    warmStartPolicy: "DRAG analytic warm start exists; cold starts also converge for 1Q",
  },
  {
    match: /rydberg|neutral.?atom|atoms?/i,
    label: "rydberg / neutral atom",
    status: "demo",
    demoRepo: "harmoniqs/atoms-demo",
    warmStartPolicy: "baseline from the J-P pulse (T·Ω_max = 7.61); free-phase objective is critical",
    warmStarts: [
      { id: "rydberg-CZ-quera-v1", note: "F = 0.99999, 273 ns, deep blockade" },
      { id: "rydberg-CZ-v1", note: "two-qubit CZ" },
      { id: "rydberg-X-v1", note: "single-qubit X" },
    ],
  },
  {
    match: /fluxonium/i,
    label: "fluxonium",
    status: "demo",
    demoRepo: "harmoniqs/fluxonium-demo",
    warmStartPolicy: "COLD START ONLY — warm starts regress on fluxonium (vault doctrine); multistart for Y",
  },
  {
    match: /ion|ytterbium|yb/i,
    label: "trapped ion",
    status: "demo",
    demoRepo: "harmoniqs/ions",
    warmStartPolicy: "Mølmer-Sørensen demos (QSCOUT ¹⁷¹Yb⁺) in the demo repo",
  },
  {
    match: /bosonic|cavity|gkp|cat/i,
    label: "bosonic / cavity",
    status: "demo",
    demoRepo: "harmoniqs/nyu-bosonic-demo (+ gkp-stanford)",
    warmStartPolicy: "structured ECD warm start; never perturb long-T warm starts (vault doctrine)",
  },
  {
    match: /nv.?center|nitrogen/i,
    label: "NV center",
    status: "demo",
    demoRepo: "harmoniqs/nv-center-demo",
  },
  {
    match: /spin/i,
    label: "spin qubit",
    status: "demo",
    demoRepo: "harmoniqs/spin-qubit-demo",
  },
];

/** The family a modality answer belongs to, if any. */
export function platformFamily(modality: string): PlatformFamily | undefined {
  return PLATFORM_FAMILIES.find((f) => f.match.test(modality));
}

// ---------------------------------------------------------------------------
// The gate — generic sanity + registry walk.
// ---------------------------------------------------------------------------

export interface EnvelopeResult {
  ok: boolean;
  reason?: string;
  /** The matched spec on ok — the solve leg reads templateFile/fill off it. */
  template?: TemplateSpec;
}

/** What the vetted registry can honestly honor. The interview captures the
 *  user's true system; this guard keeps the Solve leg from running mislabeled
 *  physics — a "rydberg" answer must never run through TransmonSystem. Pure. */
export function templateEnvelope(slots: InterviewSlots, registry: TemplateSpec[] = SOLVE_TEMPLATES): EnvelopeResult {
  const levels = Array.isArray(slots.levels) ? slots.levels : [slots.levels];
  // Numeric sanity FIRST: a malformed résumé ("T": "10 ns", missing N) must
  // never reach the Julia script with Solve enabled. Registry-independent.
  const numeric: Array<[string, unknown]> = [["T", slots.T], ["N", slots.N], ["drive_max", slots.drive_max], ["max_iter", slots.max_iter]];
  for (const [name, v] of numeric) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return { ok: false, reason: `"${name}" isn't a valid number — use the update box to have Amico fix it` };
    }
  }
  if (levels.length === 0 || levels.some((l) => typeof l !== "number" || !Number.isFinite(l) || l < 2)) {
    return { ok: false, reason: `"levels" isn't valid (each subsystem needs ≥2 levels) — use the update box to have Amico fix it` };
  }

  const candidates = registry.filter((t) => t.modality.test(slots.modality));
  if (!candidates.length) {
    const vetted = registry.map((t) => t.label).join(", ");
    // Not a dead end: name where this family's physics already lives.
    const fam = platformFamily(slots.modality);
    const path = fam?.demoRepo ? ` The ${fam.label} solve already exists in ${fam.demoRepo} — it needs the amicode run-dir wrap + a registry entry.` : "";
    const seeds = fam?.warmStarts?.length ? ` Catalog warm starts ready: ${fam.warmStarts.map((w) => w.id).join(", ")}.` : "";
    return { ok: false, reason: `no vetted template for ${slots.modality} yet — vetted so far: ${vetted}.${path}${seeds}` };
  }
  // First candidate whose declaration covers the slots wins; otherwise report
  // the FIRST candidate's first failure (good enough while families have one
  // entry each — revisit ranking when e.g. transmon-1q and transmon-2q coexist).
  let firstReason: string | undefined;
  for (const t of candidates) {
    const reason = checkAgainst(t, slots, levels);
    if (!reason) return { ok: true, template: t };
    firstReason ??= reason;
  }
  return { ok: false, reason: firstReason };
  // device_limits deliberately never checked: hardware limits inform the
  // agent's sanity checks on T/drive_max, they don't change what a template models.
}

function checkAgainst(t: TemplateSpec, slots: InterviewSlots, levels: number[]): string | undefined {
  const param = t.paramCheck?.(slots);
  if (param) return param;
  if (levels.length > t.maxSubsystems) {
    return "multi-subsystem models (e.g. qubit + coupler levels) need a template we haven't vetted yet";
  }
  const extras = (slots.physics ?? []).filter((p) => !t.physics.test(p) && !/default|none/i.test(p));
  if (extras.length) {
    return `the vetted ${t.label} template doesn't model: ${extras.join(", ")}`;
  }
  if (!t.gates.test(slots.gate)) {
    return `"${slots.gate}" is outside the vetted gate set (${t.gatesLabel}) — custom or state-prep targets need a template extension`;
  }
  if (slots.frame && !t.frame.test(slots.frame)) {
    return `the vetted template works in ${t.frameLabel} — "${slots.frame}" isn't modeled yet`;
  }
  if (slots.modulation && !t.modulation.test(slots.modulation)) {
    return `the vetted template assumes ${t.modulationLabel} — "${slots.modulation}" isn't modeled yet`;
  }
  if (slots.bounds && !t.supportsBounds) {
    return "only the symmetric per-quadrature drive bound is modeled — richer bounds need a template extension";
  }
  return undefined;
}

/** Deterministic template fill — the solve leg's critical path. Substitutions
 *  come from the matched spec; throws when an expected FILL-IN pattern is
 *  missing (template drift must be LOUD: a silent skip would run template
 *  defaults instead of the user's values). */
export function fillTemplate(template: string, slots: InterviewSlots, spec: TemplateSpec = TRANSMON_1Q): string {
  let out = template;
  for (const { pattern, value } of spec.fill) {
    const sub = value(slots);
    if (sub === undefined) continue;   // deliberately untouched (e.g. default δ)
    if (!pattern.test(out)) throw new Error(`solve template drifted — FILL-IN pattern not found: ${pattern}`);
    out = out.replace(pattern, sub);
  }
  return out;
}
