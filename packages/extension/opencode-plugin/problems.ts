// ============================================================================
// Problem-workspace fs operations (spec A) for the amicode_* tool pack.
//
// SIBLING-MODULE RULES (same as ./score_guard): imported by amicode_tools.ts
// inside opencode's Bun runtime via a relative `./problems` import — node:
// builtins only, named exports fine (the single-export constraint is the plugin
// entry's). Pure-ish fs logic, unit-tested from test/problems.test.ts against a
// temp $AMICODE_PROBLEMS_DIR.
//
// A Problem workspace (~/.amico/problems/<slug>/) is the durable unit of identity
// that replaces the global _entities singleton: it owns entities, an append-only
// events.jsonl (the provenance spine), run REFS (runs.toml/.json — never run
// data), and the authored solve.jl (spec C). The plugin is TOML-writer-only, so
// every read/merge goes through the `.json` sidecars.
// ============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  problemToml,
  problemJson,
  runRefsToml,
  runRefsJson,
  deriveSlug,
  type ProblemMeta,
  type RunRef,
} from "./entities";

const ACTIVE_FILE = "active";

/** Root of all problem workspaces. $AMICODE_PROBLEMS_DIR overrides (test + the
 *  extension-side grant point here identically). */
export function problemsDir(): string {
  const env = process.env.AMICODE_PROBLEMS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "problems");
}

export function problemDir(slug: string): string {
  return path.join(problemsDir(), slug);
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// --- active pointer ----------------------------------------------------------

/** The active problem slug, or undefined when absent OR dangling (the pointer
 *  names a dir that no longer exists — callers auto-create in that case). */
export function readActiveSlug(): string | undefined {
  const file = path.join(problemsDir(), ACTIVE_FILE);
  if (!fs.existsSync(file)) return undefined;
  const slug = fs.readFileSync(file, "utf8").trim();
  if (!slug) return undefined;
  if (!fs.existsSync(problemDir(slug))) return undefined; // dangling
  return slug;
}

export function setActiveSlug(slug: string): void {
  atomicWrite(path.join(problemsDir(), ACTIVE_FILE), slug + "\n");
}

// --- problem.json (the machine-read source) ----------------------------------

function readProblemMeta(slug: string): ProblemMeta | undefined {
  const file = path.join(problemDir(slug), "problem.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ProblemMeta;
  } catch {
    return undefined;
  }
}

/** Write both problem.toml and its .json sidecar, stamping `recorded` = now. */
function writeProblemMeta(meta: ProblemMeta): void {
  const stamped: ProblemMeta = { ...meta, recorded: new Date().toISOString() };
  atomicWrite(path.join(problemDir(meta.slug), "problem.toml"), problemToml(stamped));
  atomicWrite(path.join(problemDir(meta.slug), "problem.json"), problemJson(stamped));
}

/** First non-colliding slug: `base`, then `base-2`, `base-3`, … */
function uniqueSlug(base: string): string {
  if (!fs.existsSync(problemDir(base))) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(problemDir(candidate))) return candidate;
  }
}

// --- lifecycle ---------------------------------------------------------------

export function listProblems(): ProblemMeta[] {
  const root = problemsDir();
  if (!fs.existsSync(root)) return [];
  const out: ProblemMeta[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = readProblemMeta(entry.name);
    if (meta) out.push(meta);
  }
  return out;
}

export function createProblem(name: string): ProblemMeta {
  const slug = uniqueSlug(deriveSlug(name));
  const meta: ProblemMeta = { name, slug, created: new Date().toISOString(), status: "designing" };
  fs.mkdirSync(path.join(problemDir(slug), "entities"), { recursive: true });
  writeProblemMeta(meta);
  setActiveSlug(slug);
  appendEvent(slug, { entity: "problem", action: "created" });
  return meta;
}

/** Open by exact slug (works for archived too), else fuzzy by name
 *  (case-insensitive substring, archived excluded). Sets active on a hit. */
export function openProblem(query: string): ProblemMeta | undefined {
  const exact = readProblemMeta(query);
  if (exact) {
    setActiveSlug(query);
    return exact;
  }
  const q = query.toLowerCase().trim();
  const matches = listProblems().filter((m) => m.status !== "archived" && m.name.toLowerCase().includes(q));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b.recorded ?? "").localeCompare(a.recorded ?? ""));
  setActiveSlug(matches[0].slug);
  return matches[0];
}

/** Rename a problem. Name always updates. The slug (= dir) changes ONLY for an
 *  auto-generated `untitled-*` slug (then: dir rename + active update); an
 *  established slug is immutable so external refs stay valid. */
export function renameProblem(slug: string, newName: string): ProblemMeta {
  const meta = readProblemMeta(slug);
  if (!meta) throw new Error(`no such problem: ${slug}`);
  if (slug.startsWith("untitled")) {
    const wasActive = readActiveSlug() === slug;
    const newSlug = uniqueSlug(deriveSlug(newName));
    fs.renameSync(problemDir(slug), problemDir(newSlug));
    const updated: ProblemMeta = { ...meta, name: newName, slug: newSlug };
    writeProblemMeta(updated);
    if (wasActive) setActiveSlug(newSlug);
    appendEvent(newSlug, {
      entity: "problem",
      action: "renamed",
      diff: { name: { from: meta.name, to: newName }, slug: { from: slug, to: newSlug } },
    });
    return updated;
  }
  const updated: ProblemMeta = { ...meta, name: newName };
  writeProblemMeta(updated);
  appendEvent(slug, { entity: "problem", action: "renamed", diff: { name: { from: meta.name, to: newName } } });
  return updated;
}

export function archiveProblem(slug: string): ProblemMeta {
  const meta = readProblemMeta(slug);
  if (!meta) throw new Error(`no such problem: ${slug}`);
  const updated: ProblemMeta = { ...meta, status: "archived" };
  writeProblemMeta(updated);
  appendEvent(slug, { entity: "problem", action: "archived", diff: { status: { from: meta.status, to: "archived" } } });
  return updated;
}

/** The active problem, auto-creating an `Untitled <date>` one when the pointer
 *  is absent or dangling (fast-path sessions must never stall on bookkeeping). */
export function ensureActiveProblem(): ProblemMeta {
  const active = readActiveSlug();
  if (active) {
    const meta = readProblemMeta(active);
    if (meta) return meta;
  }
  return createProblem(`Untitled ${new Date().toISOString().slice(0, 10)}`);
}

// --- event log ---------------------------------------------------------------

export interface EventInput {
  entity: string;
  action: string;
  // The structured convention for ENTITY events is { from, to } per key
  // (entityDiff); the recommend/veloce events deliberately write FLAT diffs
  // (their readers key on the flat fields — e.g. e.diff.mode). The input type
  // accepts both (#700: the tool bodies moved under tsc and the flat form is
  // the recorded runtime reality).
  diff?: Record<string, unknown>;
  hash?: string;
  source?: { tool?: string; stage?: string; session?: string };
}

/** The last (highest) event seq recorded for a problem, or 0 if none. Used by
 *  the tools to emit an honest `seq` in the AMICODE_DIFF sentinel for lifecycle
 *  events that problems.ts appends internally (create/rename/archive). */
export function lastEventSeq(slug: string): number {
  const file = path.join(problemDir(slug), "events.jsonl");
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "").length;
}

/** Append one event to the problem's events.jsonl; returns its monotonic seq
 *  (= existing non-empty line count + 1). `ts` + `provenance:null` are stamped. */
export function appendEvent(slug: string, input: EventInput): number {
  const file = path.join(problemDir(slug), "events.jsonl");
  let seq = 1;
  if (fs.existsSync(file)) {
    seq =
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "").length + 1;
  }
  const record = {
    seq,
    ts: new Date().toISOString(),
    entity: input.entity,
    action: input.action,
    ...(input.diff !== undefined ? { diff: input.diff } : {}),
    ...(input.hash !== undefined ? { hash: input.hash } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    provenance: null,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return seq;
}

// --- run refs + entity files -------------------------------------------------

/** Append a run ref to BOTH runs.json (read source) and runs.toml (human). */
export function appendRunRef(slug: string, ref: RunRef): void {
  const jsonFile = path.join(problemDir(slug), "runs.json");
  let refs: RunRef[] = [];
  if (fs.existsSync(jsonFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as { runs?: RunRef[] };
      if (Array.isArray(parsed.runs)) refs = parsed.runs;
    } catch {
      refs = [];
    }
  }
  refs.push(ref);
  atomicWrite(jsonFile, runRefsJson(refs));
  atomicWrite(path.join(problemDir(slug), "runs.toml"), runRefsToml(refs));
}

/** Write an entity's TOML + JSON sidecar under <workspace>/entities/. */
export function writeEntityFiles(slug: string, kind: string, toml: string, json: string): void {
  const dir = path.join(problemDir(slug), "entities");
  atomicWrite(path.join(dir, `${kind}.toml`), toml);
  atomicWrite(path.join(dir, `${kind}.json`), json);
}

// --- migration ---------------------------------------------------------------

const LEGACY_ENTITY_KINDS = new Set(["system", "formulation", "run", "device_session", "calibration"]);

/** One-shot legacy `_entities/` → problem-workspace migration. Reshapes the flat
 *  legacy dir into `<problemsRoot>/legacy-<date>/`: entity files under entities/,
 *  score-state files (score_manifest/interview_state/usage) at the workspace root,
 *  a synthesized archived problem.toml/.json, and `active` set only when no other
 *  problem exists. Roots are injectable for testing; the env-skip guard lives at
 *  the module-load CALL SITE (amicode_tools.ts), NOT here. No-op when the legacy
 *  source is absent or the problems root already exists. */
export function migrateLegacyEntities(
  legacySrc: string = path.join(os.homedir(), ".amico", "runs", "default", "_entities"),
  problemsRoot: string = problemsDir(),
): void {
  if (!fs.existsSync(legacySrc)) return; // nothing to migrate
  if (fs.existsSync(problemsRoot)) return; // already migrated / problems exist
  const slug = `legacy-${new Date().toISOString().slice(0, 10)}`;
  const ws = path.join(problemsRoot, slug);
  const wsEntities = path.join(ws, "entities");
  fs.mkdirSync(wsEntities, { recursive: true });
  for (const file of fs.readdirSync(legacySrc)) {
    const src = path.join(legacySrc, file);
    if (!fs.statSync(src).isFile()) continue;
    const m = file.match(/^(.+)\.(toml|json)$/);
    const isEntity = m !== null && LEGACY_ENTITY_KINDS.has(m[1]);
    fs.copyFileSync(src, path.join(isEntity ? wsEntities : ws, file));
  }
  const meta: ProblemMeta = {
    name: "Legacy entities",
    slug,
    created: new Date().toISOString(),
    status: "archived",
    recorded: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ws, "problem.toml"), problemToml(meta));
  fs.writeFileSync(path.join(ws, "problem.json"), problemJson(meta));
  const others = fs
    .readdirSync(problemsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== slug);
  if (others.length === 0) fs.writeFileSync(path.join(problemsRoot, "active"), slug + "\n");
}
