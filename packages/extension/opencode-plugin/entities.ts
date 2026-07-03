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
  platform: "transmon" | "rydberg";
  levels: number;
  /** Named physical parameters, e.g. omega/delta (GHz), drive_max. */
  params: Record<string, number>;
}

export interface FormulationEntity {
  problem: string;
  target: string;
  objective: string;
  constraints: string[];
}

export interface RunStub {
  formulation_ref?: string;
  system_ref?: string;
  /** Run directory, when the bash launch already happened and the agent knows it. */
  run_dir?: string;
  /** Optional free-text note ("X gate, defaults"). */
  note?: string;
}

export const PLATFORMS = ["transmon", "rydberg"] as const;
export const MIN_LEVELS = 2;
export const MAX_LEVELS = 6;

// --- validation --------------------------------------------------------------

/** Problems with a SystemEntity; [] means valid. */
export function validateSystem(e: SystemEntity): string[] {
  const problems: string[] = [];
  if (!(PLATFORMS as readonly string[]).includes(e.platform)) {
    problems.push(`unknown platform "${e.platform}" — expected one of: ${PLATFORMS.join(", ")}`);
  }
  if (!Number.isInteger(e.levels) || e.levels < MIN_LEVELS || e.levels > MAX_LEVELS) {
    problems.push(`levels must be an integer in [${MIN_LEVELS}, ${MAX_LEVELS}], got ${e.levels}`);
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
  const lines = [
    "[system]",
    `platform = ${tomlEscape(e.platform)}`,
    `levels = ${e.levels}`,
    `recorded = ${tomlEscape(isoNow(now))}`,
    "",
    "[system.params]",
    ...Object.entries(e.params).map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`),
  ];
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
  lines.push(`launched_via = ${tomlEscape("bash amico-run")}`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  return lines.join("\n") + "\n";
}
