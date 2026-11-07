// The notturno job registry — the TS-native port of amicissimo's
// automation/notturno/registry.py (amicode #1669, the #852 step-6 A1′ leg).
// PARITY OVER REWRITE: this module parses THE SAME registry file
// (notturno.toml) and produces byte-equivalent coverage verdicts and parse
// errors to the Python engine — the pinned fixtures in test/fixtures/notturno
// were captured by running the Python engine (amicissimo 12e1141) against
// them. The Python tree stays (coexistence is the design); no deletion here.
//
// The registry is job truth (ADR 0001): every scheduled agentic job with its
// cadence, surface, warrant tier, and delivery. Coverage is total — every
// workflow file is either a registered job or a named exclude.
//
// The instance deny-list (amicissimo #490's boundary artifact — the format
// this public side consumes) is a LOAD-BEARING input: a registry named by a
// deny row is instance config and fails LOUDLY at the verb layer, pointing at
// the private instance's runner. This module only DETECTS; notturno_verb.ts
// refuses.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

// ── the vocabulary (the Python enums, as typed values) ──────────────────────────

/** Execution surfaces (ADR 0001 — the MacBook is never a surface). */
export type Surface = "github-hosted" | "erlich" | "mini";
/** Warrant tiers (ADR 0001 — new jobs default to stage). */
export type Warrant = "report" | "stage" | "gated";
/** Pass-recording modes: `acted` jobs record only when they acted. */
export type RecordMode = "always" | "acted";

export const SURFACES = ["github-hosted", "erlich", "mini"] as const;
export const WARRANTS = ["report", "stage", "gated"] as const;
export const RECORD_MODES = ["always", "acted"] as const;

// ── the registry types ──────────────────────────────────────────────────────────

/** One registered notturno job. */
export interface NotturnoJob {
  id: string;
  workflow: string;
  cadence: string;
  surface: Surface;
  warrant: Warrant;
  delivers: string[];
  enabled: boolean;
  record: RecordMode;
  /** Job-owned config (a [job.<id>.config] table of string paths); additive
   *  territory — jobs without one parse to an empty mapping. */
  config: Record<string, string>;
}

/** A workflow file deliberately outside the registry, with its reason. */
export interface NotturnoExclude {
  workflow: string;
  reason: string;
}

export interface NotturnoRegistry {
  jobs: NotturnoJob[];
  excludes: NotturnoExclude[];
}

export type RegistryResult = { ok: true; registry: NotturnoRegistry } | { ok: false; error: string };

/** Format a list like Python's tuple repr, for byte-parity error messages:
 *  ("a", "b") → "('a', 'b')". */
function pyTuple(items: readonly string[]): string {
  return `(${items.map((i) => `'${i}'`).join(", ")})`;
}

/** The Python type name for a TOML value, for byte-parity error messages
 *  (the config-table error names what it got: str, int, float, bool, list). */
function pyTypeName(value: unknown): string {
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function parseJob(jid: string, raw: Record<string, unknown>): { ok: true; job: NotturnoJob } | { ok: false; error: string } {
  for (const key of ["workflow", "cadence", "surface", "warrant"]) {
    if (!(key in raw)) return { ok: false, error: `job '${jid}': missing required key '${key}'` };
  }
  const surface = String(raw.surface);
  if (!(SURFACES as readonly string[]).includes(surface))
    return { ok: false, error: `job '${jid}': unknown surface '${surface}' (expected one of ${pyTuple(SURFACES)})` };
  const warrant = String(raw.warrant);
  if (!(WARRANTS as readonly string[]).includes(warrant))
    return { ok: false, error: `job '${jid}': unknown warrant '${warrant}' (expected one of ${pyTuple(WARRANTS)})` };
  const record = String(raw.record ?? "always");
  if (!(RECORD_MODES as readonly string[]).includes(record))
    return { ok: false, error: `job '${jid}': unknown record '${record}' (expected one of ${pyTuple(RECORD_MODES)})` };
  const configRaw = raw.config ?? {};
  if (typeof configRaw !== "object" || configRaw === null || Array.isArray(configRaw))
    return {
      ok: false,
      error: `job '${jid}': 'config' must be a [job.${jid}.config] table of paths, got ${pyTypeName(raw.config)}`,
    };
  return {
    ok: true,
    job: {
      id: jid,
      workflow: String(raw.workflow),
      cadence: String(raw.cadence),
      surface: surface as Surface,
      warrant: warrant as Warrant,
      delivers: Array.isArray(raw.delivers) ? raw.delivers.map(String) : [],
      enabled: Boolean(raw.enabled ?? false),
      record: record as RecordMode,
      config: Object.fromEntries(Object.entries(configRaw).map(([k, v]) => [k, String(v)])),
    },
  };
}

/** Parse notturno.toml into a Registry, validating each job record with the
 *  Python engine's exact messages. */
export function loadRegistry(path: string): RegistryResult {
  let data: Record<string, unknown>;
  try {
    data = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `cannot load registry at ${path}: ${(e as Error).message}` };
  }
  const jobs: NotturnoJob[] = [];
  for (const [jid, raw] of Object.entries((data.job ?? {}) as Record<string, Record<string, unknown>>)) {
    const parsed = parseJob(jid, raw ?? {});
    if (!parsed.ok) return { ok: false, error: parsed.error };
    jobs.push(parsed.job);
  }
  const excludes: NotturnoExclude[] = [];
  for (const row of (data.exclude ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.workflow !== "string") return { ok: false, error: "exclude entry missing its 'workflow'" };
    excludes.push({ workflow: row.workflow, reason: typeof row.reason === "string" ? row.reason : "" });
  }
  return { ok: true, registry: { jobs, excludes } };
}

/** Reconcile the registry against a workflows directory: the exact Python
 *  problem strings (empty = coverage is total). A missing dir reads as
 *  empty — Python's Path.glob on a nonexistent dir yields nothing. */
export function coverage(reg: NotturnoRegistry, workflowsDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(workflowsDir);
  } catch {
    // parity: no dir → no files
  }
  const onDisk = new Set(names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")));
  const registered = new Set(reg.jobs.map((j) => j.workflow));
  const excluded = new Set(reg.excludes.map((e) => e.workflow));
  const problems: string[] = [];
  for (const name of [...onDisk].filter((n) => !registered.has(n) && !excluded.has(n)).sort())
    problems.push(`workflow '${name}' is neither a registered job nor an exclude`);
  for (const name of [...registered].filter((n) => !onDisk.has(n)).sort())
    problems.push(`job workflow '${name}' has no file in ${workflowsDir}`);
  for (const name of [...excluded].filter((n) => !onDisk.has(n)).sort())
    problems.push(`exclude workflow '${name}' has no file in ${workflowsDir}`);
  return problems;
}

// ── the instance deny list (amicissimo #490's boundary artifact) ────────────────

/** One [[deny]] row of an instance-deny-list.toml manifest. */
export interface DenyRow {
  path: string;
  reason: string;
}

export type DenyListResult = { ok: true; deny: DenyRow[] } | { ok: false; error: string };

/** Parse an instance-deny-list manifest ([[deny]] rows; [[core]] rows are the
 *  instance tree's own classification and are not consumed here). */
export function loadDenyList(path: string): DenyListResult {
  let data: Record<string, unknown>;
  try {
    data = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `cannot load deny list at ${path}: ${(e as Error).message}` };
  }
  const deny: DenyRow[] = [];
  for (const row of (data.deny ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.path !== "string")
      return { ok: false, error: `cannot load deny list at ${path}: a [[deny]] row is missing its path` };
    deny.push({ path: row.path, reason: typeof row.reason === "string" ? row.reason : "" });
  }
  return { ok: true, deny };
}

/** Does a deny row claim this path? Rows are repo-root-relative (the
 *  amicissimo manifest's shape) or absolute; a row names a file or a
 *  directory — a directory claims every file under it, recursively (the
 *  manifest's own rule). Portable matching: a row claims the target when it
 *  is the target's suffix at a path boundary, so the row
 *  "automation/notturno/notturno.toml" claims that file in ANY tree it lives
 *  in — the conservative direction a deny list wants (the #490 doctrine: the
 *  deny list never guesses a path public). */
export function deniedBy(target: string, deny: DenyRow[]): DenyRow | undefined {
  const tgt = target.split("\\").join("/").replace(/\/+$/, "");
  for (const row of deny) {
    const rel = row.path.split("\\").join("/").replace(/\/+$/, "");
    if (tgt === rel || tgt.endsWith("/" + rel) || tgt.includes("/" + rel + "/")) return row;
  }
  return undefined;
}

/** Find the boundary manifest for a registry: beside the registry first (the
 *  amicissimo layout — notturno.toml and instance-deny-list.toml are
 *  siblings), then up the ancestor chain (repo-root-relative rows imply the
 *  manifest may sit above). First existing file wins; none → undefined (a
 *  public registry carries no manifest). */
export function discoverDenyList(registryPath: string): string | undefined {
  for (let d = dirname(registryPath); ; d = dirname(d)) {
    const cand = join(d, "instance-deny-list.toml");
    if (existsSync(cand)) return cand;
    if (dirname(d) === d) return undefined;
  }
}

/** Find the repo workflows dir above a registry — Python's module-relative
 *  default made portable: the first existing .github/workflows walking up
 *  from the registry's directory. */
export function discoverWorkflowsDir(registryPath: string): string | undefined {
  for (let d = dirname(registryPath); ; d = dirname(d)) {
    const cand = join(d, ".github", "workflows");
    if (existsSync(cand)) return cand;
    if (dirname(d) === d) return undefined;
  }
}
