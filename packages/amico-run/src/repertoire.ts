// The pulse REPERTOIRE (a.k.a. the catalog) — the durable store of promoted
// pulses under the company vault: ~/.amico/vaults/armonissima/catalog/pulses/<id>/
// carrying a flat `metadata.toml` + a git-lfs `pulse.jld2` (the amico-catalog
// skill's Phase-0 schema). This is the pure core behind the `amico catalog` verb
// (issue #111, slice B2): warm-start QUERY (rank incumbents by fidelity) and the
// half of INGEST that decides the version bump. It generalizes the amico-catalog
// skill's retrieval + ingestion protocol into deterministic, bash-callable logic.
//
// Loaders never throw: a missing/corrupt catalog degrades to an EMPTY repertoire,
// exactly like src/catalog.ts's template/exemplar loaders degrade to tier 3. A
// record missing a discriminating field (id/platform/gate/fidelity) is skipped,
// not fatal.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** A flat `metadata.toml` pulse record (amico-catalog Phase-0 schema). Known keys
 *  are typed; `dir` is the resolved on-disk entry directory (never persisted). */
export interface PulseRecord {
  id: string;
  platform: string;
  gate: string;
  fidelity: number;
  duration_us?: number;
  pulse_type?: string;
  N_knots?: number;
  free_phase?: boolean;
  path?: string; // pulse.jld2 path, relative to the catalog ROOT (parent of pulses/)
  branch?: string;
  warm_start?: string; // lineage: the incumbent id this was warm-started from
  tags?: string[];
  date?: string; // ISO date "YYYY-MM-DD"
  // ── SEAM 5 (amicode #681): the calibrate→pin→re-optimize chain's provenance ──
  // The chain's re-bank carries its fingerprint — which calibration, which pin,
  // which warm-start seed — as ADDITIVE metadata fields (`warm_start` above IS
  // the seed). The recording path (extension opencode-plugin/calib_chain.ts)
  // VERIFIES these before the chain's executed marker can land. Additive keys:
  // old entries simply lack them.
  calibration_ref?: string; // which calibration: the chain record / rehearsal artifact ref
  pinned_globals?: Record<string, number>; // which pin: global → calibrated value
  // ── SEAM 3 (amicode #714): the shape quartet, REFERENCED from the promoted
  // run's result.toml params.shape_metrics (PR #713's emission — Piccolo's
  // definition is the one; the stamp cites the source, never re-computes).
  // ── #711 (F-709-2): the device the entry was tuned against, flag-sourced
  // (`catalog ingest --device`) — no record kind carries a device field, so the
  // flag is the honest source. Both additive: old entries simply lack them.
  shape_metrics?: ShapeQuartet;
  device?: string;
  dir: string; // ABS path to the entry directory
}

// ── the shape quartet (SEAM 3, amicode #714) ─────────────────────────────────
/** Piccolo.shape_metrics over the SOLVED pulse — bend (∫|u″|²dt), int_u2 (the
 *  Bloch–Siegert proxy), max_du (intra-span slew), crest (hardware ACDR check),
 *  plus the carried T + parameterization. REFERENCED, never re-defined: the
 *  stamp is a validated copy of what the run's result payload carries, with
 *  the citation in `source`. A half-parseable quartet is worse than absent —
 *  `parseShapeQuartet` returns undefined unless all four arrays are clean. */
export interface ShapeQuartet {
  bend: number[];
  int_u2: number[];
  max_du: number[];
  crest: number[];
  T?: number;
  parameterization?: string;
  source?: string; // the citation the stamp carries (who computed it, where it rode)
}

/** The citation every quartet stamp carries — the metric vocabulary is
 *  Piccolo's (shape_metrics), the payload path is the run's result.toml
 *  `params.shape_metrics`. Never re-computed downstream. */
export const SHAPE_METRICS_SOURCE = "Piccolo.shape_metrics (the run's result.toml params.shape_metrics)";

function finiteNumArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  return v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [...(v as number[])] : undefined;
}

/** Validate + copy a quartet-shaped value (a result payload or a metadata
 *  table). Returns undefined for anything that isn't a clean quartet —
 *  absent-means-absent, never a half-stamp, never an error. */
export function parseShapeQuartet(v: unknown): ShapeQuartet | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  const bend = finiteNumArray(t.bend);
  const int_u2 = finiteNumArray(t.int_u2);
  const max_du = finiteNumArray(t.max_du);
  const crest = finiteNumArray(t.crest);
  if (!bend || !int_u2 || !max_du || !crest) return undefined;
  const out: ShapeQuartet = { bend, int_u2, max_du, crest };
  if (typeof t.T === "number" && Number.isFinite(t.T)) out.T = t.T;
  if (typeof t.parameterization === "string" && t.parameterization !== "") out.parameterization = t.parameterization;
  if (typeof t.source === "string" && t.source !== "") out.source = t.source;
  return out;
}

/** The repertoire's `pulses/` directory. `$AMICO_CATALOG_DIR` overrides it (tests
 *  point it at a temp dir); default is the company-vault mount. Mirrors the
 *  extension's run_controls.catalogPulsesDir, but returns the path unconditionally
 *  — loadRepertoire handles a missing mount by returning []. */
export function catalogPulsesDir(): string {
  const env = process.env.AMICO_CATALOG_DIR;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "vaults", "armonissima", "catalog", "pulses");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function dateStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10); // smol-toml bare-date → TomlDate
  return undefined;
}

/** A `[pinned_globals]`-style inline table: every value a finite number. Returns
 *  undefined for anything that isn't a clean number table (SEAM 5 #681 — a
 *  half-parseable pin set is worse than absent). */
function pinTable(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "number" || !Number.isFinite(val)) return undefined;
    out[k] = val;
  }
  return out;
}

function parseRecord(file: string, dir: string): PulseRecord | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const id = str(parsed.id);
  const platform = str(parsed.platform);
  const gate = str(parsed.gate);
  const fidelity = num(parsed.fidelity);
  // Can't query or rank a record missing a discriminating field — skip, don't crash.
  if (!id || !platform || !gate || fidelity === undefined) return undefined;
  return {
    id,
    platform,
    gate,
    fidelity,
    dir,
    duration_us: num(parsed.duration_us),
    pulse_type: str(parsed.pulse_type),
    N_knots: num(parsed.N_knots),
    free_phase: typeof parsed.free_phase === "boolean" ? parsed.free_phase : undefined,
    path: str(parsed.path),
    branch: str(parsed.branch),
    // real entries use `warm_start`; the skill doc example says `warm_started_from` — accept both.
    warm_start: str(parsed.warm_start) ?? str(parsed.warm_started_from),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : undefined,
    date: dateStr(parsed.date),
    // SEAM 5 (#681): the chain provenance — additive, absent on pre-chain entries.
    calibration_ref: str(parsed.calibration_ref),
    pinned_globals: pinTable(parsed.pinned_globals),
    // SEAM 3 (#714) + #711: additive, absent on entries promoted before them.
    shape_metrics: parseShapeQuartet(parsed.shape_metrics),
    device: str(parsed.device),
  };
}

/** Scan each entry's `<id>/metadata.toml` under the pulses dir into records.
 *  Never throws. */
export function loadRepertoire(pulsesDir: string): PulseRecord[] {
  if (!existsSync(pulsesDir)) return [];
  let names: string[];
  try {
    names = readdirSync(pulsesDir);
  } catch {
    return [];
  }
  const records: PulseRecord[] = [];
  for (const name of names) {
    const dir = join(pulsesDir, name);
    const file = join(dir, "metadata.toml");
    if (!existsSync(file)) continue;
    const rec = parseRecord(file, dir);
    if (rec) records.push(rec);
  }
  return records;
}

/** amico-catalog "Version" rule: better = higher fidelity; if fidelity ties,
 *  shorter duration wins; if both tie, indistinguishable. Returns >0 if `a` beats
 *  `b`, <0 if `b` beats `a`, 0 if neither. */
export function comparePulses(a: PulseRecord, b: PulseRecord): number {
  if (a.fidelity !== b.fidelity) return a.fidelity - b.fidelity;
  const da = a.duration_us ?? Infinity;
  const db = b.duration_us ?? Infinity;
  return db - da; // shorter duration → larger score (better)
}

export interface QueryResult {
  incumbent?: PulseRecord; // the best-ranked match, if any
  candidates: PulseRecord[]; // all matches, ranked best → worst
}

/** Warm-start lookup: matches on platform + gate, ranked by comparePulses. */
export function queryIncumbent(records: PulseRecord[], platform: string, gate: string): QueryResult {
  const candidates = records
    .filter((r) => r.platform === platform && r.gate === gate)
    .sort((a, b) => comparePulses(b, a)); // best first
  return { incumbent: candidates[0], candidates };
}

/** Does `candidate` beat the incumbent? No incumbent → always (first of its kind). */
export function beats(candidate: PulseRecord, incumbent: PulseRecord | undefined): boolean {
  if (!incumbent) return true;
  return comparePulses(candidate, incumbent) > 0;
}

/** `{platform}-{gate}-v{N+1}`, where N is the highest existing version for this
 *  (platform, gate). No prior entry → v1. */
export function nextVersionId(records: PulseRecord[], platform: string, gate: string): string {
  const prefix = `${platform}-${gate}-v`;
  let max = 0;
  for (const r of records) {
    if (!r.id.startsWith(prefix)) continue;
    const n = Number(r.id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}
