// ============================================================================
// Entity TOML writers for the amicode_* tool pack — pure, dependency-free.
//
// This file is imported from TWO runtimes and must stay import-free (types +
// functions only, no node: builtins, no npm packages):
//   1. opencode's embedded Bun runtime — amicode_tools.ts (the plugin, loaded
//      by absolute path via OPENCODE_CONFIG_CONTENT `plugin: [...]`) does
//      `import { ... } from "./entities"`; Bun transpiles TS natively and
//      resolves the relative sibling, but nothing guarantees npm resolution
//      from this directory, so we depend on nothing.
//   2. vitest (test/amicode_tools.test.ts) — round-trips the emitted TOML
//      through `smol-toml`, the parser @amicode/schema and the extension use.
//
// Entities live under <entitiesDir> (see amicode_tools.ts): System and
// Formulation are the interview's durable design state; the Run *stub* records
// that a launch was requested — it is bookkeeping, NOT the run-dir `run.toml`
// that amico-run itself writes (different directory, different schema).
//
// `recorded` is emitted as a QUOTED ISO-8601 string, not a bare TOML datetime:
// smol-toml parses bare datetimes into TomlDate objects (schema/src/index.ts
// has a note on exactly this trap), and downstream consumers want a plain
// string. Serializers throw on invalid entities; validate* return a list of
// human-readable problems so tools can answer the chat without throwing.
// ============================================================================

export interface SystemEntity {
  /** Open platform string (spec A): any platform a Legato/Piccolo/Intonato user
   *  names. Known platforms (KNOWN_PLATFORMS) keep their affordances; unknown
   *  ones are recorded honestly. Validated non-empty. */
  platform: string;
  /** Optional — platform-dependent. Only transmon defaults to 3; unknown
   *  platforms get no default. When given: integer >= MIN_LEVELS (no upper
   *  error — the old <=6 cap is now a tool-side warning, not a validation error). */
  levels?: number;
  /** Named physical parameters, e.g. omega/delta (GHz), drive_max. */
  params: Record<string, number>;
  /** Free text for what params can't hold (e.g. topology prose). EXCLUDED from
   *  the canonical hash input (prose edits must not churn identity). */
  notes?: string;
}

/** Structured solve parameters merged into the Formulation (spec A): they are the
 *  hash-relevant "duration/knots + integrator + parameterization + pinned globals"
 *  half of amicode#64's formulation_hash. Written by amicode_solve. */
export interface SolveParams {
  T?: number;
  N?: number;
  max_iter?: number;
  integrator?: string;
  parameterization?: string;
  pinned_globals?: string[];
}

export interface FormulationEntity {
  problem: string;
  target: string;
  objective: string;
  constraints: string[];
  /** Solve params (spec A) — present once amicode_solve has recorded them. */
  solve?: SolveParams;
}

export interface RunStub {
  formulation_ref?: string;
  system_ref?: string;
  /** Run directory, when the bash launch already happened and the agent knows it. */
  run_dir?: string;
  /** Authoring tier (spec C): vetted | composed | free. */
  tier?: "vetted" | "composed" | "free";
  /** Path to the authored script (spec C — workspace-owned solve.jl). */
  script_ref?: string;
  /** Resolved env binding kind (spec C). */
  env?: string;
  /** Free-tier re-rollout verification outcome (spec C) — recorded by
   *  amicode_verify after amico-run's harness writes verification.toml. Spec B's
   *  entity view renders it beside the tier; promotion is gated on agree. */
  verification?: {
    agree: boolean;
    fidelity_rerolled?: number | null;
    fidelity_reported?: number | null;
  };
  /** Optional free-text note ("X gate, defaults"). */
  note?: string;
}

/** Problem workspace identity (spec A) — the `[problem]` table of problem.toml. */
export interface ProblemScoreRef {
  id: string;
  version: number;
}

export interface ProblemEnvBinding {
  /** provisioned (~/.amico/julia) | project (a Julia project path) | sandbox
   *  (generated per-problem). NO cloud kind — executor routing is per-solve. */
  kind: "provisioned" | "project" | "sandbox";
  path?: string;
}

export interface ProblemMeta {
  name: string;
  slug: string;
  created: string;
  /** Only these two persist; solving/solved are display-derived (spec A). */
  status: "designing" | "archived";
  recorded?: string;
  score?: ProblemScoreRef;
  env?: ProblemEnvBinding;
}

/** A reference into ~/.amico/runs/<lab>/<runId> (spec A) — the workspace stores
 *  refs only; RunsManager's runs/index is the run source of truth. */
export interface RunRef {
  run_id: string;
  lab: string;
  tier?: "vetted" | "composed" | "free";
  recorded: string;
}

/** Stage-8 guided stub (amicode_to_hardware): records intent to send a pulse to
 *  a device. THIS BUILD PERFORMS NO DEVICE I/O — `gate` and `checks` are fixed
 *  by the serializer (pending-human-signoff + the auto-check list), never
 *  caller-supplied, so a stub can't claim an approval that didn't happen. */
export interface DeviceSessionStub {
  /** The solved pulse artifact (pulse.jld2) if known. */
  pulse_ref?: string;
  /** The run directory the pulse came from, if known. */
  run_dir?: string;
  note?: string;
}

/** Guided follow-up stub (amicode_calibrate): the calibration loop that follows
 *  hardware runs. `loop`/`status` are fixed by the serializer — "not-wired" is
 *  the honest state of this build. */
export interface CalibrationStub {
  device_session_ref?: string;
  note?: string;
}

/** Platforms with built-in affordances (Hamiltonian LaTeX, defaults). NOT a
 *  closed validation set anymore (spec A opened `platform` to any string) — this
 *  is the hint list for tool descriptions. PLATFORMS kept as an alias for the
 *  existing amicode_tools.ts import. */
export const KNOWN_PLATFORMS = ["transmon", "rydberg"] as const;
export const PLATFORMS = KNOWN_PLATFORMS;
export const MIN_LEVELS = 2;
/** Soft cap: >MAX_LEVELS is a tool-side warning, no longer a validation error. */
export const MAX_LEVELS = 6;

// --- validation --------------------------------------------------------------

/** Problems with a SystemEntity; [] means valid. Opened model (spec A): any
 *  non-empty platform string; levels optional and, when given, an integer
 *  >= MIN_LEVELS (no upper bound — the >6 case is a warning surfaced by the
 *  tool, not a validation error). */
export function validateSystem(e: SystemEntity): string[] {
  const problems: string[] = [];
  if (typeof e.platform !== "string" || e.platform.trim() === "") {
    problems.push(`platform must be a non-empty string`);
  }
  if (e.levels !== undefined && (!Number.isInteger(e.levels) || e.levels < MIN_LEVELS)) {
    problems.push(`levels, when given, must be an integer >= ${MIN_LEVELS}, got ${e.levels}`);
  }
  for (const [k, v] of Object.entries(e.params ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`param "${k}" must be a finite number, got ${v}`);
    }
  }
  return problems;
}

/** Problems with a FormulationEntity; [] means valid. */
export function validateFormulation(e: FormulationEntity): string[] {
  const problems: string[] = [];
  if (typeof e.problem !== "string" || e.problem.trim() === "") problems.push("problem must be non-empty");
  if (typeof e.target !== "string" || e.target.trim() === "") problems.push("target must be non-empty");
  if (typeof e.objective !== "string" || e.objective.trim() === "") problems.push("objective must be non-empty");
  if (!Array.isArray(e.constraints) || e.constraints.some((c) => typeof c !== "string")) {
    problems.push("constraints must be an array of strings");
  }
  return problems;
}

// --- merge (amicode_set_model) ------------------------------------------------

export interface SystemPatch {
  levels?: number;
  params?: Record<string, number>;
}

/** Merge a set_model patch into an existing SystemEntity (pure — returns a new
 *  object; the input is never mutated). Throws if the RESULT is invalid, so a
 *  bad patch can never corrupt a previously-valid recorded entity. */
export function updateSystem(existing: SystemEntity, patch: SystemPatch): SystemEntity {
  const merged: SystemEntity = {
    platform: existing.platform,
    levels: patch.levels ?? existing.levels,
    params: { ...existing.params, ...(patch.params ?? {}) },
  };
  if (existing.notes !== undefined) merged.notes = existing.notes;
  const problems = validateSystem(merged);
  if (problems.length) throw new Error(`invalid system after merge: ${problems.join("; ")}`);
  return merged;
}

// --- TOML emission -------------------------------------------------------------

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}

/** A TOML key: bare when safe, basic-quoted otherwise. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlEscape(k);
}

/** Finite-number TOML literal (validators guarantee finiteness before this). */
function tomlNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`param value ${v} has no TOML representation`);
  return String(v);
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

/** Serialize a SystemEntity:
 *  [system] platform/levels/recorded + [system.params] name = value. Throws on
 *  an invalid entity. `now` is injectable for deterministic tests. */
export function systemToml(e: SystemEntity, now?: Date): string {
  const problems = validateSystem(e);
  if (problems.length) throw new Error(`invalid system: ${problems.join("; ")}`);
  const lines = ["[system]", `platform = ${tomlEscape(e.platform)}`];
  if (e.levels !== undefined) lines.push(`levels = ${e.levels}`);
  if (e.notes !== undefined) lines.push(`notes = ${tomlEscape(e.notes)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`, "", "[system.params]");
  lines.push(...Object.entries(e.params).map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`));
  return lines.join("\n") + "\n";
}

/** Serialize a FormulationEntity under [formulation]. Throws on invalid. */
export function formulationToml(e: FormulationEntity, now?: Date): string {
  const problems = validateFormulation(e);
  if (problems.length) throw new Error(`invalid formulation: ${problems.join("; ")}`);
  const lines = [
    "[formulation]",
    `problem = ${tomlEscape(e.problem)}`,
    `target = ${tomlEscape(e.target)}`,
    `objective = ${tomlEscape(e.objective)}`,
    `constraints = [${e.constraints.map(tomlEscape).join(", ")}]`,
    `recorded = ${tomlEscape(isoNow(now))}`,
  ];
  // [formulation.solve] sub-table (spec A) — MUST follow all [formulation]
  // scalar keys (TOML: no keys added to a table after a sub-table opens).
  if (e.solve) {
    const s = e.solve;
    lines.push("", "[formulation.solve]");
    if (s.T !== undefined) lines.push(`T = ${tomlNumber(s.T)}`);
    if (s.N !== undefined) lines.push(`N = ${tomlNumber(s.N)}`);
    if (s.max_iter !== undefined) lines.push(`max_iter = ${tomlNumber(s.max_iter)}`);
    if (s.integrator !== undefined) lines.push(`integrator = ${tomlEscape(s.integrator)}`);
    if (s.parameterization !== undefined) lines.push(`parameterization = ${tomlEscape(s.parameterization)}`);
    if (s.pinned_globals !== undefined) {
      lines.push(`pinned_globals = [${s.pinned_globals.map(tomlEscape).join(", ")}]`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Serialize the Run bookkeeping stub under [run]. `launched_via` is fixed to
 *  "bash amico-run": the amicode_solve tool records intent only — the actual
 *  launch is the AGENTS.md bash workflow, never this tool. Optional refs are
 *  omitted (not written as "") when absent. */
export function runStubToml(stub: RunStub, now?: Date): string {
  const lines = ["[run]"];
  if (stub.formulation_ref !== undefined) lines.push(`formulation_ref = ${tomlEscape(stub.formulation_ref)}`);
  if (stub.system_ref !== undefined) lines.push(`system_ref = ${tomlEscape(stub.system_ref)}`);
  if (stub.run_dir !== undefined) lines.push(`run_dir = ${tomlEscape(stub.run_dir)}`);
  if (stub.tier !== undefined) lines.push(`tier = ${tomlEscape(stub.tier)}`);
  if (stub.script_ref !== undefined) lines.push(`script_ref = ${tomlEscape(stub.script_ref)}`);
  if (stub.env !== undefined) lines.push(`env = ${tomlEscape(stub.env)}`);
  lines.push(`launched_via = ${tomlEscape("bash amico-run")}`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  if (stub.verification !== undefined) {
    lines.push("", "[run.verification]", `agree = ${stub.verification.agree}`);
    if (stub.verification.fidelity_rerolled != null)
      lines.push(`fidelity_rerolled = ${stub.verification.fidelity_rerolled}`);
    if (stub.verification.fidelity_reported != null)
      lines.push(`fidelity_reported = ${stub.verification.fidelity_reported}`);
  }
  return lines.join("\n") + "\n";
}

// --- problem workspace serializers (spec A) ----------------------------------

/** Serialize ProblemMeta under [problem] (+ [problem.score]/[problem.env]).
 *  `recorded` defaults to now when absent. */
export function problemToml(meta: ProblemMeta, now?: Date): string {
  const lines = [
    "[problem]",
    `name = ${tomlEscape(meta.name)}`,
    `slug = ${tomlEscape(meta.slug)}`,
    `created = ${tomlEscape(meta.created)}`,
    `status = ${tomlEscape(meta.status)}`,
    `recorded = ${tomlEscape(meta.recorded ?? isoNow(now))}`,
  ];
  if (meta.score) {
    lines.push("", "[problem.score]", `id = ${tomlEscape(meta.score.id)}`, `version = ${meta.score.version}`);
  }
  if (meta.env) {
    lines.push("", "[problem.env]", `kind = ${tomlEscape(meta.env.kind)}`);
    if (meta.env.path !== undefined) lines.push(`path = ${tomlEscape(meta.env.path)}`);
  }
  return lines.join("\n") + "\n";
}

/** Serialize an array of RunRefs as [[runs]] array-of-tables. */
export function runRefsToml(refs: RunRef[]): string {
  const blocks = refs.map((r) => {
    const lines = ["[[runs]]", `run_id = ${tomlEscape(r.run_id)}`, `lab = ${tomlEscape(r.lab)}`];
    if (r.tier !== undefined) lines.push(`tier = ${tomlEscape(r.tier)}`);
    lines.push(`recorded = ${tomlEscape(r.recorded)}`);
    return lines.join("\n");
  });
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

/** JSON sidecars — the machine-read source (the plugin is TOML-writer-only, so
 *  all reads/merges go through these). */
export function problemJson(meta: ProblemMeta): string {
  return JSON.stringify(meta, null, 2) + "\n";
}

export function runRefsJson(refs: RunRef[]): string {
  return JSON.stringify({ runs: refs }, null, 2) + "\n";
}

// --- canonical serialization + diffs (spec A / amicode#64) -------------------

/** Keys excluded from the canonical hash input: `recorded` (clock ticks) and
 *  `notes` (prose) must not churn entity identity. The #64 coordination seam —
 *  number normalization is JSON.stringify's default for v1 (revisit with #64). */
const HASH_EXCLUDED_KEYS = new Set(["recorded", "notes"]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (HASH_EXCLUDED_KEYS.has(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Canonical JSON: recursively key-sorted, `recorded`/`notes` and undefined
 *  dropped at every level. The hash input for hashes.ts (spec A / #64). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Kebab-case slug from a problem name; empty result → "untitled". */
export function deriveSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** Flatten one level of nested objects to dotted keys (`params.drive_max`),
 *  dropping `recorded`. Arrays are treated as scalar values. */
function flattenForDiff(e: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!e) return out;
  for (const [k, v] of Object.entries(e)) {
    if (k === "recorded") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) out[`${k}.${sk}`] = sv;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Structured diff of two entity snapshots → { dottedKey: {from, to} } for
 *  changed keys only. `before === undefined` (create) → every `from` is null. */
export function entityDiff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, { from: unknown; to: unknown }> {
  const b = flattenForDiff(before);
  const a = flattenForDiff(after);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const fromV = k in b ? b[k] : null;
    const toV = k in a ? a[k] : null;
    if (JSON.stringify(fromV) !== JSON.stringify(toV)) {
      diff[k] = { from: before === undefined ? null : fromV, to: toV };
    }
  }
  return diff;
}

/** Keep the AMICODE_DIFF sentinel line small: truncate long string values, then,
 *  if still over budget, drop trailing entries and mark with an "…" key. */
export function truncateDiffForSentinel(
  diff: Record<string, { from: unknown; to: unknown }>,
  maxBytes = 1024,
): Record<string, { from: unknown; to: unknown }> {
  const trunc = (v: unknown): unknown =>
    typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, { from, to }] of Object.entries(diff)) out[k] = { from: trunc(from), to: trunc(to) };
  const keys = Object.keys(out);
  const total = keys.length;
  while (JSON.stringify(out).length > maxBytes && keys.length > 0) {
    delete out[keys.pop()!];
    out["…"] = { from: null, to: `${total - keys.length} more fields` };
  }
  return out;
}

/** A given-but-empty ref is a caller bug (an ABSENT ref is fine — omit the key). */
function requireNonEmptyRef(name: string, value: string | undefined): void {
  if (value !== undefined && value.trim() === "") {
    throw new Error(`${name} must be non-empty when given — omit it (null) if unknown`);
  }
}

/** The stage-8 send-to-device gate's automated checks — fixed, not caller data:
 *  they describe what the gate WILL verify, not what happened (nothing happens
 *  in this build). Human visual sign-off follows the auto checks. */
const HARDWARE_CHECKS = ["fidelity>=threshold", "|drive|<=cap", "bandwidth", "leakage"] as const;

/** Serialize the DeviceSession stub under [device_session]. `gate` is pinned to
 *  "pending-human-signoff" and `checks` to HARDWARE_CHECKS (see interface note). */
export function deviceSessionStubToml(stub: DeviceSessionStub, now?: Date): string {
  requireNonEmptyRef("pulse_ref", stub.pulse_ref);
  requireNonEmptyRef("run_dir", stub.run_dir);
  const lines = ["[device_session]"];
  if (stub.pulse_ref !== undefined) lines.push(`pulse_ref = ${tomlEscape(stub.pulse_ref)}`);
  if (stub.run_dir !== undefined) lines.push(`run_dir = ${tomlEscape(stub.run_dir)}`);
  lines.push(`gate = ${tomlEscape("pending-human-signoff")}`);
  lines.push(`checks = [${HARDWARE_CHECKS.map(tomlEscape).join(", ")}]`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  return lines.join("\n") + "\n";
}

/** Serialize the Calibration stub under [calibration]. `loop` is pinned to "ILC"
 *  (iterative learning control — the loop that follows hardware runs) and
 *  `status` to "not-wired": this build records the follow-up, nothing more. */
export function calibrationStubToml(stub: CalibrationStub, now?: Date): string {
  requireNonEmptyRef("device_session_ref", stub.device_session_ref);
  const lines = ["[calibration]"];
  if (stub.device_session_ref !== undefined) {
    lines.push(`device_session_ref = ${tomlEscape(stub.device_session_ref)}`);
  }
  lines.push(`loop = ${tomlEscape("ILC")}`);
  lines.push(`status = ${tomlEscape("not-wired")}`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  return lines.join("\n") + "\n";
}
