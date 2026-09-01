// ============================================================================
// SEAM 2 (amicode #699) — regime rules as recommendations: the five-knob
// priors table's schema, serving path, and audit query (F2's sensor).
//
// SIBLING-MODULE RULES (same as ./calib_chain): this module runs inside
// opencode's embedded Bun runtime via a relative `./regime_priors` import —
// node: builtins + the ./ledger_client sibling only, no other npm packages,
// never anything from ../src/. Its data file
// (./regime_priors_table.json) is committed GENERATED content: distilled from
// the internal tier's profile census by an internal-env distiller script (the
// regeneration wiring to the freshness cadence is a named follow-up, not this
// slice), and re-validated here on every load.
//
// THE A1 BOUNDARY (the whole point of this module's shape): prior VALUES +
// provenance strings ship; the regime-rule ENGINE and the VENDOR_PROFILES
// internals never do. The table CITES its sources (public-scale arXiv/meeting
// citations, demo cards, skill doctrine, issue/PR numbers — all shippable);
// it does not include or re-implement them: no crossover logic, no per-vendor
// drift scales or trust geometry, no vendor attribution. The public-scale
// caveat ("do not cite as device data") rides the table and every entry's
// provenance — validateRegimePriorsTable enforces that, and the test suite's
// leak guard enforces the attribution-free line mechanically.
//
// Serving seam: amicode_recommend action="query" composes these static
// priors (scoped by the session's platform FAMILY — spin / transmon / atom,
// never a vendor) with the existing ledger priors. The existing mechanics
// own confidence capping (ledger-sourced caps at medium; static priors state
// their confidence explicitly — high for fixture-validated values, low for
// starting-point ranges).
//
// The audit (amicode_recommend action="audit") is F2's mechanical sensor: a
// query over prior-application events (the propose/outcome events the
// EXISTING amico_recommend mechanics append to the workspace's events.jsonl
// — the flywheel's input side, no new feed) that FAILS when a prior is applied
// outside its profile scope without the public-scale caveat surfaced; the
// with-caveat case passes (the caveat is the point). It also surfaces census
// staleness when handed a current census that differs from the table's stamp.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── the schema's vocabulary ─────────────────────────────────────────────────

/** The five NAMED calibration knobs (issue #699 AC1: one prior per NAMED
 * knob — `regime_rec_priors_live == 5`). `beta` / `y_goal` / `gls_weighting`
 * are the ASCII param ids for β / y_goal / "GLS weighting"; each entry's
 * `label` carries the issue's name for it. */
export const REGIME_KNOBS = [
  "tr_frac",
  "beta",
  "y_goal",
  "gls_weighting",
  "min_contrast",
] as const;
export type RegimeKnob = (typeof REGIME_KNOBS)[number];

/** Platform FAMILY keying (issue #699 Key Decision): the recommendation
 * surface is coarse (the interview's platform axis), so vendor profiles
 * aggregate into family priors with the census + sources in the provenance —
 * never vendor keying, never vendor attribution. */
export type PlatformFamily = "spin" | "transmon" | "atom";
export const PLATFORM_FAMILIES: PlatformFamily[] = ["spin", "transmon", "atom"];

/** The profile census a table was distilled from: families + count + date.
 * DYNAMIC-CENSUS CONTRACT: a census change makes the table stale (see the
 * table's `dynamic_census_contract`); the audit surfaces the staleness when
 * handed a current census that differs from this stamp. */
export interface CensusStamp {
  date: string;
  total: number;
  families: Partial<Record<PlatformFamily, number>>;
}

/** One entry's provenance — the shippable face of the A1 boundary: scope
 * (the platform families the prior covers), the census it distilled from,
 * its evidence chain (public-scale citations), and the public-scale caveat
 * riding every entry. */
export interface PriorProvenance {
  scope: PlatformFamily[];
  census: CensusStamp;
  sources: string[];
  caveat: string;
}

export interface RegimePriorEntry {
  knob: RegimeKnob;
  label?: string;
  /** The platform families this entry serves (the lookup key). */
  families: PlatformFamily[];
  value: number | string;
  confidence: "high" | "medium" | "low";
  note?: string;
  provenance: PriorProvenance;
}

export interface RegimePriorsTable {
  schema: string;
  dynamic_census_contract: string;
  caveat: string;
  census: CensusStamp;
  priors: RegimePriorEntry[];
}

export type LoadResult =
  | { ok: true; table: RegimePriorsTable }
  | { ok: false; problems: string[] };

/** The public-scale caveat's load-bearing marker — the source profiles' own
 * rule, enforced on the table, every entry, and every served string. */
export const CAVEAT_MARKER = "do not cite as device data";

// ── validation (a malformed table fails; a malformed provenance fails) ─────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function censusEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateCensus(v: unknown, where: string, problems: string[]): v is CensusStamp {
  if (!isRecord(v)) {
    problems.push(`${where}: census must be an object {date, total, families}`);
    return false;
  }
  if (typeof v.date !== "string" || Number.isNaN(Date.parse(v.date))) {
    problems.push(`${where}: census.date must be a date string`);
  }
  if (typeof v.total !== "number" || !Number.isInteger(v.total) || v.total <= 0) {
    problems.push(`${where}: census.total must be a positive integer`);
  }
  if (!isRecord(v.families) || Object.keys(v.families).length === 0) {
    problems.push(`${where}: census.families must be a non-empty object`);
  } else {
    let sum = 0;
    for (const [name, count] of Object.entries(v.families)) {
      if (!(PLATFORM_FAMILIES as string[]).includes(name)) {
        problems.push(`${where}: census.families has unknown family "${name}"`);
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
        problems.push(`${where}: census.families.${name} must be a positive integer`);
      } else {
        sum += count;
      }
    }
    if (typeof v.total === "number" && sum !== v.total) {
      problems.push(`${where}: census.total (${v.total}) != the sum of family counts (${sum})`);
    }
  }
  return problems.length === 0;
}

/** Validate a raw (parsed) priors table against the schema — every problem is
 * a string; an empty array means the table is servable. Enforces: the schema
 * id, the dynamic-census contract's presence, the caveat marker, the census
 * stamp's arithmetic, every entry's provenance (scope == families, census ==
 * the table's stamp, non-empty sources, the caveat riding it), and the
 * five-knob coverage per census family (AC1's `regime_rec_priors_live == 5`
 * made mechanical at the schema level). */
export function validateRegimePriorsTable(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(raw)) return ["the priors table must be a JSON object"];
  if (raw.schema !== "amicode.regime-priors/v1") {
    problems.push(`schema: expected "amicode.regime-priors/v1", got ${JSON.stringify(raw.schema)}`);
  }
  if (typeof raw.dynamic_census_contract !== "string" || !/census/i.test(raw.dynamic_census_contract) || !/stale/i.test(raw.dynamic_census_contract)) {
    problems.push("dynamic_census_contract: must state the dynamic-census contract (naming census + staleness)");
  }
  if (typeof raw.caveat !== "string" || !raw.caveat.includes(CAVEAT_MARKER)) {
    problems.push(`caveat: must carry the public-scale caveat (containing "${CAVEAT_MARKER}")`);
  }
  if (!validateCensus(raw.census, "census", problems)) {
    // census already pushed its problems; entries below still validated best-effort
  }
  const censusFamilies = isRecord(raw.census) && isRecord(raw.census.families)
    ? (Object.keys(raw.census.families) as PlatformFamily[])
    : [];
  if (!Array.isArray(raw.priors) || raw.priors.length === 0) {
    problems.push("priors: must be a non-empty array");
    return problems;
  }
  for (let i = 0; i < raw.priors.length; i++) {
    const e = raw.priors[i];
    const where = `priors[${i}]`;
    if (!isRecord(e)) {
      problems.push(`${where}: must be an object`);
      continue;
    }
    if (!(REGIME_KNOBS as readonly string[]).includes(e.knob as string)) {
      problems.push(`${where}: knob "${String(e.knob)}" is not one of the five NAMED knobs`);
    }
    const fams = e.families;
    if (!Array.isArray(fams) || fams.length === 0) {
      problems.push(`${where}: families must be a non-empty array`);
    } else {
      for (const f of fams) {
        if (!censusFamilies.includes(f)) {
          problems.push(`${where}: family "${String(f)}" is outside the census families`);
        }
      }
    }
    if (typeof e.value !== "number" && (typeof e.value !== "string" || e.value.trim() === "")) {
      problems.push(`${where}: value must be a number or non-empty string`);
    }
    if (e.confidence !== "high" && e.confidence !== "medium" && e.confidence !== "low") {
      problems.push(`${where}: confidence must be high | medium | low`);
    }
    // ── provenance: malformed provenance FAILS (the table cites, precisely) ──
    const p = e.provenance;
    if (!isRecord(p)) {
      problems.push(`${where}.provenance: must be an object {scope, census, sources, caveat}`);
      continue;
    }
    const scope = p.scope;
    if (!Array.isArray(scope) || scope.length === 0) {
      problems.push(`${where}.provenance.scope: must be a non-empty array`);
    } else {
      if (!Array.isArray(fams) || JSON.stringify([...scope].sort()) !== JSON.stringify([...fams].sort())) {
        problems.push(`${where}.provenance.scope: must name exactly the entry's families (the profile scope)`);
      }
      for (const f of scope) {
        if (!censusFamilies.includes(f)) {
          problems.push(`${where}.provenance.scope: family "${String(f)}" is outside the census families`);
        }
      }
    }
    if (!isRecord(p.census) || !censusEqual(p.census, raw.census)) {
      problems.push(`${where}.provenance.census: must name the table's census stamp exactly`);
    }
    if (!Array.isArray(p.sources) || p.sources.length === 0 || p.sources.some((s) => typeof s !== "string" || s.trim() === "")) {
      problems.push(
        `${where}.provenance.sources: must be a non-empty array of non-empty strings (the evidence chain)`,
      );
    }
    if (typeof p.caveat !== "string" || !p.caveat.includes(CAVEAT_MARKER) || p.caveat !== raw.caveat) {
      problems.push(`${where}.provenance.caveat: must be the table's public-scale caveat verbatim`);
    }
  }
  // ── AC1 coverage: every NAMED knob servable for every census family ──
  for (const knob of REGIME_KNOBS) {
    for (const fam of censusFamilies) {
      const covered = (raw.priors as RegimePriorEntry[]).some(
        (e) => e.knob === knob && Array.isArray(e.families) && e.families.includes(fam),
      );
      if (!covered) {
        problems.push(`coverage: knob "${knob}" has no prior scoped to family "${fam}" (regime_rec_priors_live must be 5 per family)`);
      }
    }
  }
  return problems;
}

// ── loading the committed data file ──────────────────────────────────────────

/** The committed table's directory — resolved from THIS module's url so the
 * load works identically in the Bun plugin runtime, in vitest, and in the
 * packaged vsix (the whole opencode-plugin dir ships together). */
export function regimePriorsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function regimePriorsTablePath(): string {
  return join(regimePriorsDir(), "regime_priors_table.json");
}

/** Load + validate the committed table. Never throws: a corrupt table is an
 * honest `{ok:false, problems}` (the serving path degrades to "no regime
 * priors", never to a served lie). */
export function loadRegimePriorsTable(): LoadResult {
  const file = regimePriorsTablePath();
  if (!existsSync(file)) return { ok: false, problems: [`the regime priors table is missing at ${file}`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, problems: [`the regime priors table does not parse: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problems = validateRegimePriorsTable(raw);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, table: raw as RegimePriorsTable };
}

// ── the coarse platform axis ─────────────────────────────────────────────────

/** Map an open platform string (the interview's platform axis — spec A keeps
 * it open) onto a census FAMILY. Family keying, never vendor keying (issue
 * #699 Key Decision): the recommendation surface is coarse, so the vendor
 * profiles aggregate into family priors. Returns undefined outside the
 * census families — an unmapped platform serves NO prior (honest absence,
 * never a nearest-guess). */
export function platformFamily(platform: string): PlatformFamily | undefined {
  const p = platform.toLowerCase();
  if (p.includes("transmon")) return "transmon";
  if (p.includes("rydberg") || p.includes("atom")) return "atom";
  if (p.includes("spin")) return "spin";
  return undefined;
}

// ── the serving selection (AC1: regime_rec_priors_live == 5) ─────────────────

/** A served regime prior — the shape that rides the recommendation surface
 * (amicode_recommend action="query"). `provenance` is the composed, shippable
 * string (scope + census + sources + caveat); `scope` and `ref` stay
 * machine-readable so the propose events the agent records through the
 * EXISTING mechanics are audit-parseable (see auditRegimePriors). */
export interface RegimePriorRec {
  param: RegimeKnob;
  label: string;
  value: number | string;
  confidence: "high" | "medium" | "low";
  provenance: string;
  scope: PlatformFamily[];
  ref: string;
  note?: string;
}

/** The served provenance string — the shippable face of the A1 boundary:
 * profile scope + the census stamp + the evidence chain + the public-scale
 * caveat riding every served string. Composed here (never stored) so every
 * consumer of a prior names its sources identically — the audit parses these
 * markers back out of prior-application events. */
export function priorProvenanceString(entry: RegimePriorEntry, table: RegimePriorsTable): string {
  const census = table.census;
  const families = PLATFORM_FAMILIES.filter((f) => census.families[f] !== undefined)
    .map((f) => `${census.families[f]} ${f}`)
    .join(" / ");
  return (
    `scope: ${entry.provenance.scope.join(", ")}; ` +
    `census: ${census.date}, ${census.total} profiles: ${families}; ` +
    `sources: ${entry.provenance.sources.join("; ")}; ` +
    `caveat: ${entry.provenance.caveat}`
  );
}

/** Select the regime priors for a platform family — ONE per NAMED knob
 * (exactly the five, per issue #699 AC1). `knobs` (optional) projects to the
 * requested knob names, mirroring the query path's `params` selection. */
export function selectRegimePriors(
  table: RegimePriorsTable,
  family: PlatformFamily,
  knobs?: readonly string[],
): RegimePriorRec[] {
  const wanted = knobs && knobs.length > 0 ? (knobs as readonly string[]) : REGIME_KNOBS;
  const out: RegimePriorRec[] = [];
  for (const knob of wanted) {
    if (!(REGIME_KNOBS as readonly string[]).includes(knob)) continue;
    const entry = table.priors.find((e) => e.knob === knob && e.families.includes(family));
    if (!entry) continue; // the schema validator guarantees coverage; a gap degrades honestly
    out.push({
      param: entry.knob,
      label: entry.label ?? entry.knob,
      value: entry.value,
      confidence: entry.confidence,
      provenance: priorProvenanceString(entry, table),
      scope: entry.provenance.scope,
      ref: `regime_priors_table.json#${entry.knob}@${family}`,
      ...(entry.note !== undefined ? { note: entry.note } : {}),
    });
  }
  return out;
}
