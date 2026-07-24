// ============================================================================
// ledger_client.ts — the amicode_* tool pack's ONLY door to the run ledger
// (Plan 3 / L1 Tasks 6–7). SINGLE-WRITER DISCIPLINE: this module never touches
// ~/.amico/ledger/runs.jsonl directly — every append shells to `amico ledger
// append` (amico-run is the sole writer). Queries shell to `amico ledger
// query`. Both degrade gracefully (undefined / false), never throw: a ledger
// hiccup must never break a chat-tool call (mirrors local_executor.ts's
// "never fail the run" doctrine, one layer up).
//
// SIBLING-MODULE RULES (same as ./problems, ./score_guard): amicode_tools.ts
// runs inside opencode's embedded Bun runtime via a relative `./ledger_client`
// import — ONLY relative sibling imports resolve there (node: builtins fine);
// bare package specifiers (`@amicode/amico-run`, `@amicode/schema`) do NOT. This
// is why structure_hash is read from a prior run's result.toml (Task 5 already
// put it there) rather than recomputed via @amicode/schema's structureHash() —
// that function is unreachable from this file by construction, not by choice.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { problemDir } from "./problems";
import type { RunRef } from "./entities";

// ── amico binary resolution ──────────────────────────────────────────────────
// Mirrors src/opencode_paths.ts's resolveAmicoRunBinDir (duplicated, not
// imported — see the sibling-module note above): packaged layout stages
// <extensionRoot>/bin/launcher/amico; the dev tree keeps it at the sibling
// package packages/amico-run/launcher/amico.
export function resolveAmicoBinFrom(extensionRoot: string): string | undefined {
  const staged = join(extensionRoot, "bin", "launcher", "amico");
  if (existsSync(staged)) return staged;
  const sibling = join(extensionRoot, "..", "amico-run", "launcher", "amico");
  if (existsSync(sibling)) return sibling;
  return undefined;
}

function resolveAmicoBin(): string {
  if (process.env.AMICO_BIN && process.env.AMICO_BIN.trim() !== "") return process.env.AMICO_BIN;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../opencode-plugin
    const extensionRoot = join(here, ".."); // .../extension (dev) or the packaged root
    const found = resolveAmicoBinFrom(extensionRoot);
    if (found) return found;
  } catch {
    /* import.meta.url unavailable — fall through to PATH */
  }
  return "amico"; // last resort: rely on PATH
}

// ── shelling primitives ──────────────────────────────────────────────────────
/** Append one ledger record by shelling `amico ledger append` (stdin payload —
 *  avoids arg-length/quoting limits on large `summary`/`errors` payloads).
 *  Returns false (never throws) on any failure — a ledger append must never
 *  break the tool call that triggered it. */
export function appendStanza(rec: Record<string, unknown>): boolean {
  try {
    execFileSync(resolveAmicoBin(), ["ledger", "append"], {
      input: JSON.stringify(rec),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export interface LedgerParamStat {
  value: number;
  iqr: [number, number];
  n: number;
}
export interface LedgerCategoricalStat {
  value: string;
  n: number;
  total: number;
}
export interface LedgerQueryResult {
  key: "primary" | "fallback" | "none";
  structure_hash: string;
  total: number;
  verified: number;
  params: Partial<Record<string, LedgerParamStat | LedgerCategoricalStat>>;
  provenance: string;
  confidence: "high" | "medium" | "low";
}

export interface Recommendation {
  param: string;
  value: number | string;
  provenance: string;
  confidence: "high" | "medium" | "low";
}

/** INTERIM CAP (spec L-A#3 / success criterion 5) — do NOT remove until L-H
 *  (per-structure trust, L3) provides a real trust gate. Today's veloce policy
 *  auto-accepts any `high`-confidence recommendation (confidence-rubric.md);
 *  ledger_query.ts already caps at `medium` when any contributing run is
 *  unverified, but this is a SECOND, belt-and-suspenders clamp at the tool
 *  boundary — defense in depth so no future caller of queryLedger has to
 *  re-derive the same guard to keep ledger-sourced `high` unreachable. */
function clampLedgerConfidence(c: "high" | "medium" | "low"): "high" | "medium" | "low" {
  return c === "high" ? "medium" : c;
}

/** Project a LedgerQueryResult down to the requested param names (or every
 *  param the query matched, when none requested), each tagged with the
 *  `ledger` provenance source and the interim-capped confidence. Pure —
 *  the tool boundary just formats this into a response string. */
export function selectRecommendations(result: LedgerQueryResult, params?: string[]): Recommendation[] {
  const confidence = clampLedgerConfidence(result.confidence);
  const wanted = params && params.length > 0 ? params : Object.keys(result.params);
  const out: Recommendation[] = [];
  for (const p of wanted) {
    const stat = result.params[p];
    if (!stat) continue;
    out.push({ param: p, value: stat.value, provenance: result.provenance, confidence });
  }
  return out;
}

/** Query honest priors at `structureHash × (n, t)` by shelling `amico ledger
 *  query`. Returns undefined (never throws) when the shell fails or the output
 *  doesn't parse — recommend degrades to "no ledger history", not an error. */
export function queryLedger(structureHash: string, n: number, t: number): LedgerQueryResult | undefined {
  try {
    const stdout = execFileSync(
      resolveAmicoBin(),
      ["ledger", "query", "--structure-hash", structureHash, "--n", String(n), "--t", String(t)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.provenance !== "string" || typeof parsed.confidence !== "string") return undefined;
    return parsed as unknown as LedgerQueryResult;
  } catch {
    return undefined;
  }
}

// ── resolving the active workspace's structure_hash ─────────────────────────
// stamps `propose`/`outcome` events AND keys `action:"query"` — both reuse the
// SAME resolution so a workspace's own recommend calls always line up with its
// own ledger entries.
export interface WorkspaceSpecContext {
  structure_hash: string;
  N?: number;
  T?: number;
}

function readTomlSafe(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mostRecentRunRef(slug: string): RunRef | undefined {
  const file = join(problemDir(slug), "runs.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { runs?: RunRef[] };
    const refs = Array.isArray(parsed.runs) ? parsed.runs : [];
    return refs.length > 0 ? refs[refs.length - 1] : undefined;
  } catch {
    return undefined;
  }
}

/** A script_path is only a ProblemSpec (not an authored .jl script) when it
 *  parses as TOML AND has a `system` table — mirrors amico-run's
 *  local_executor.ts readSpecFromScriptPath (duplicated, not imported: cross-
 *  package bare imports don't resolve in the Bun plugin runtime). */
function readSpecFromScriptPath(scriptPath: string): Record<string, unknown> | undefined {
  const spec = readTomlSafe(scriptPath);
  if (!spec || !isRecord(spec.system)) return undefined;
  return spec;
}

/** Best-effort structure_hash (+ N/T) for a problem workspace's most recent run.
 *  structure_hash comes from result.toml's [params] (Task 5 stamps it there for
 *  problem_spec-routed runs) — a workspace with no completed run, or whose
 *  runner predates Task 5's stamping, honestly has nothing to key a query on.
 *  N/T fall back to the run's solvespec (problem.toml) when result.toml doesn't
 *  carry them directly — Task 5's own summary derivation reads N/T from THERE,
 *  not from result.toml, so this mirrors the real data flow. */
export function resolveWorkspaceSpecContext(slug: string): WorkspaceSpecContext | undefined {
  const ref = mostRecentRunRef(slug);
  if (!ref) return undefined;
  const runDir = join(homedir(), ".amico", "runs", ref.lab, ref.run_id);
  const result = readTomlSafe(join(runDir, "result.toml"));
  const params = isRecord(result?.params) ? (result as Record<string, unknown>).params : undefined;
  const p = isRecord(params) ? params : {};
  const structure_hash = typeof p.structure_hash === "string" ? p.structure_hash : undefined;
  if (structure_hash === undefined) return undefined;
  let N = typeof p.N === "number" ? p.N : undefined;
  let T = typeof p.T === "number" ? p.T : undefined;
  if (N === undefined || T === undefined) {
    const manifest = readTomlSafe(join(runDir, "run.toml"));
    const scriptPath = typeof manifest?.script_path === "string" ? (manifest.script_path as string) : undefined;
    const spec = scriptPath ? readSpecFromScriptPath(scriptPath) : undefined;
    if (spec) {
      const problem = isRecord(spec.problem) ? spec.problem : {};
      const pulse = isRecord(spec.pulse) ? spec.pulse : {};
      if (N === undefined && typeof problem.N === "number") N = problem.N;
      if (T === undefined && typeof pulse.T === "number") T = pulse.T;
    }
  }
  return { structure_hash, N, T };
}

/** Thin accessor used for propose/outcome stamping — just the hash. */
export function stampStructureHash(slug: string): string | undefined {
  return resolveWorkspaceSpecContext(slug)?.structure_hash;
}

// ── Task 7: extension-side ledger stanzas (attempt_error / fallback / verdict) ──
// Every extension-side stanza is appended by shelling `amico ledger append`
// (via `appendStanza` above) — the extension never writes runs.jsonl directly.
// These builders are pure (no I/O) so the stanza SHAPE is unit-testable
// independent of the shell call; amicode_tools.ts's tool bodies (untestable via
// vitest — see its file header) just call builder → appendStanza.

export interface AttemptErrorStanza {
  type: "attempt_error";
  ts: string;
  session?: string;
  errors: Array<{ path?: string; msg?: string }>;
}

/** `attempt_error` — a spec/materialize validation failure surfaced to a tool,
 *  carrying the field-path errors (L-B: repeated identical rejections are a
 *  design signal, not a user failure). */
export function attemptErrorStanza(
  errors: Array<{ path?: string; msg?: string }>,
  session?: string,
): AttemptErrorStanza {
  return { type: "attempt_error", ts: new Date().toISOString(), ...(session ? { session } : {}), errors };
}

export interface FallbackStanza {
  type: "fallback";
  ts: string;
  from_tier: string;
  reason: string;
}

/** `fallback` — a tier demotion (e.g. composed → free, spec's `demote_to`) so
 *  L-C can rank spec-coverage gaps by measured demand. */
export function fallbackStanza(fromTier: string, reason: string): FallbackStanza {
  return { type: "fallback", ts: new Date().toISOString(), from_tier: fromTier, reason };
}

export interface VerdictStanza {
  type: "verdict";
  ts: string;
  problem_hash: string;
  structure_hash?: string;
  verdict: "agree" | "disagree";
  fidelity_rerolled?: number;
  fidelity_reported?: number;
}

/** `verdict` — amicode_verify's agree/disagree outcome, joined to its `solve`
 *  record on problem_hash (L-A's "verified" definition; L-D's sentinel input). */
export function verdictStanza(input: {
  problemHash: string;
  structureHash?: string;
  verdict: "agree" | "disagree";
  fidelityRerolled?: number;
  fidelityReported?: number;
}): VerdictStanza {
  return {
    type: "verdict",
    ts: new Date().toISOString(),
    problem_hash: input.problemHash,
    ...(input.structureHash ? { structure_hash: input.structureHash } : {}),
    verdict: input.verdict,
    ...(input.fidelityRerolled !== undefined ? { fidelity_rerolled: input.fidelityRerolled } : {}),
    ...(input.fidelityReported !== undefined ? { fidelity_reported: input.fidelityReported } : {}),
  };
}

/** Read a run dir's result.toml [params] for its structure_hash/problem_hash —
 *  the same fields Task 5's settle() stamps there. Used to key a `verdict`
 *  stanza to the run being verified (amicode_verify only has a run_dir). */
export function resolveRunHashes(runDir: string): { structure_hash?: string; problem_hash?: string } | undefined {
  const result = readTomlSafe(join(runDir, "result.toml"));
  const params = isRecord(result?.params) ? (result as Record<string, unknown>).params : undefined;
  const p = isRecord(params) ? params : {};
  const structure_hash = typeof p.structure_hash === "string" ? p.structure_hash : undefined;
  const problem_hash = typeof p.problem_hash === "string" ? p.problem_hash : undefined;
  if (structure_hash === undefined && problem_hash === undefined) return undefined;
  return { structure_hash, problem_hash };
}
