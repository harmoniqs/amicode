// AMICODE SERVICE (M1 port slice 1 — #451): data source for the home-screen
// "About you" card (GET /amicode/profile, POST /amicode/profile).
//
// PORTED, NEARLY VERBATIM, from the fork's
// packages/opencode/src/server/amicode/profile.ts @ v1.18.10-amicode.11 —
// the module was already pure node:fs/path with injectable roots, so the port
// keeps every behavior: the graceful-degradation identity synthesis (name from
// the personal vault mount, focus from the platform mix), the live "Amico
// remembers" memory ranking, the 10s response cache, and the query-param
// (NOT JSON body) field contract on POST. Parity is pinned by the contract
// tests in test/amicode_service_profile.test.ts, which replay golden fixtures
// recorded from the fork binary itself (scripts/record_amicode_fixtures.mjs).
//
// One deliberate superset: mountsFile() accepts AMICODE_MOUNTS_FILE — the fork
// resolves ~/.amico/mounts.toml from HOME only. The seam exists so tests can
// redirect state without mutating process HOME; unset, behavior is identical.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { problemsRoot, runsRoot } from "./roots";

export function profileFile(): string {
  const env = process.env.AMICODE_PROFILE_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(homedir(), ".amico", "profile.json");
}
export function mountsFile(): string {
  const env = process.env.AMICODE_MOUNTS_FILE; // port-only test seam (see header)
  if (env && env.trim() !== "") return env;
  return path.join(homedir(), ".amico", "mounts.toml");
}
/** Candidate memory dirs, first-with-notes wins. Product-shaped default is
 *  ~/.amico/memory; the Claude-Code project memory is a dev-machine fallback so
 *  the card shows real notes today without coupling the two trees. */
export function memoryDirs(): string[] {
  const out: string[] = [];
  const env = process.env.AMICODE_MEMORY_DIR;
  if (env && env.trim() !== "") out.push(env);
  out.push(path.join(homedir(), ".amico", "memory"));
  const projects = path.join(homedir(), ".claude", "projects");
  if (existsSync(projects)) {
    try {
      for (const entry of readdirSync(projects, { withFileTypes: true })) {
        if (entry.isDirectory()) out.push(path.join(projects, entry.name, "memory"));
      }
    } catch {
      /* unreadable → skip */
    }
  }
  return out;
}

export function synthesizeProfile(code: string, detail: string): string {
  return JSON.stringify({ ok: false, you: null, error: `${code}: ${detail}` });
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}
function titleCase(slug: string): string {
  return slug
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Name fallback: the personal (kind = "personal") vault mount id, minus the
 *  "armonia-" prefix, title-cased. mounts.toml is line-oriented TOML tables. */
function nameFromMounts(file: string): string | null {
  if (!existsSync(file)) return null;
  let personal = false;
  let id: string | null = null;
  let pendingId: string | null = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[[")) {
      pendingId = null;
      personal = false;
      continue;
    }
    const idMatch = line.match(/^id\s*=\s*"([^"]+)"/);
    if (idMatch) pendingId = idMatch[1];
    const kindMatch = line.match(/^kind\s*=\s*"([^"]+)"/);
    if (kindMatch && kindMatch[1] === "personal") {
      personal = true;
      if (pendingId) id = pendingId;
    }
    if (personal && !id && pendingId) id = pendingId;
  }
  if (!id) return null;
  return titleCase(id.replace(/^armonia-/, ""));
}

/** platform counts across problem workspaces (entities/system.json then
 *  problem.json), most-used first. */
function platformMix(root: string): { key: string; count: number }[] {
  if (!existsSync(root)) return [];
  const counts = new Map<string, number>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, "problem.json"))) continue;
    let platform: string | undefined;
    for (const candidate of [path.join(dir, "entities", "system.json"), path.join(dir, "problem.json")]) {
      try {
        const p = readJson(candidate)?.platform;
        if (typeof p === "string" && p.trim()) {
          platform = p.trim();
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (platform) counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function countProblems(root: string): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory() && existsSync(path.join(root, entry.name, "problem.json"))) n++;
  return n;
}

const RUN_RE = /^r(\d{4})(\d{2})(\d{2})-/;

/** Walk every lab under runsRoot; count runs, best finished fidelity,
 *  and the earliest run date ("since"). One pass. */
function runStats(root: string): {
  runs: number;
  best_fidelity: number | null;
  since: string | null;
} {
  const out = { runs: 0, best_fidelity: null as number | null, since: null as string | null };
  if (!existsSync(root)) return out;
  for (const lab of readdirSync(root, { withFileTypes: true })) {
    if (!lab.isDirectory()) continue;
    const labDir = path.join(root, lab.name);
    let runDirs: string[];
    try {
      runDirs = readdirSync(labDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of runDirs) {
      const m = name.match(RUN_RE);
      if (!m) continue;
      out.runs++;
      const dir = path.join(labDir, name);
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      if (out.since === null || date < out.since) out.since = date;
      try {
        const result = readFileSync(path.join(dir, "result.toml"), "utf8");
        const fm = result.match(/^fidelity\s*=\s*([0-9eE+.\-]+)\s*$/m);
        if (fm) {
          const f = Number(fm[1]);
          if (Number.isFinite(f) && (out.best_fidelity === null || f > out.best_fidelity)) out.best_fidelity = f;
        }
      } catch {
        /* not finished / no result */
      }
    }
  }
  return out;
}

/** Minimal frontmatter read: name, description, metadata.type. */
function readNote(file: string): { name?: string; description?: string; type?: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const fm = text.slice(3, end);
  const out: { name?: string; description?: string; type?: string } = {};
  let inMeta = false;
  for (const raw of fm.split("\n")) {
    const metaChild = raw.match(/^\s+type:\s*(.+)$/);
    if (inMeta && metaChild) {
      out.type = metaChild[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (/^\S/.test(raw)) inMeta = false;
    const m = raw.match(/^(name|description|metadata):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "metadata") {
      inMeta = true;
      const inline = m[2].match(/type:\s*(\w+)/);
      if (inline) out.type = inline[1];
      continue;
    }
    out[m[1] as "name" | "description"] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// Gentle re-rank for "Amico remembers": a practitioner opening the home screen
// cares about control/workflow guidance, not ops/infra housekeeping. Boost notes
// that read as pulse-design/workflow feedback; sink ops-flavored ones. Not a hard
// filter — a low score still surfaces if nothing better exists.
const CONTROL_TERMS =
  /pulse|fidelity|\bgate\b|solve|optimi|calibrat|integrator|trajector|duration|robust|free[-\s]?phase|parameter|benchmark|latex|\bmath\b|hamiltonian|rydberg|transmon|\batom|qubit|\bdrive|leakage|spline|warm[-\s]?start|derive|\btest\b|jacobian|hessian/i;
const OPS_TERMS =
  /vault|slack|cron|deprecat|dataroom|visionroom|mount|publish|origin|\bgit\b|plugin|armonia|\bops\b|automat|self[-\s]?dm|broadcast|terraform|resolver|\bsync\b/i;
function rememberScore(note: { name?: string; description?: string }): number {
  const hay = `${note.name ?? ""} ${note.description ?? ""}`;
  let score = 0;
  if (CONTROL_TERMS.test(hay)) score += 2;
  if (OPS_TERMS.test(hay)) score -= 2;
  return score;
}

/** LIVE "Amico remembers": behavioral (feedback) + identity (user) notes from
 *  the first memory dir that has any, ranked by relevance then recency, capped. */
function remembers(dirs: string[], limit: number): { title: string; detail: string }[] {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "memory.md");
    } catch {
      continue;
    }
    const notes = files
      .map((f) => {
        const full = path.join(dir, f);
        const note = readNote(full);
        if (!note) return null;
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* keep 0 */
        }
        return { note, mtime };
      })
      .filter((x): x is { note: NonNullable<ReturnType<typeof readNote>>; mtime: number } => !!x)
      .filter((x) => x.note.type === "feedback" || x.note.type === "user");
    if (notes.length === 0) continue;
    notes.sort((a, b) => rememberScore(b.note) - rememberScore(a.note) || b.mtime - a.mtime);
    return notes.slice(0, limit).map((x) => ({
      title: (x.note.description ?? x.note.name ?? "").trim(),
      detail: (x.note.description ?? "").trim(),
    }));
  }
  return [];
}

/** In-place profile save (About-You card inline editing). Merges ONLY the
 *  editable identity fields into ~/.amico/profile.json (derived fields —
 *  platforms/stats/remembers — are computed, never stored), invalidates the
 *  response cache, and returns the fresh profile JSON. */
export function saveProfile(fields: {
  name?: string;
  affiliation?: string;
  focus?: string;
  scholar?: string;
  affiliation_logo?: string;
}): string {
  const fp = profileFile();
  let current: any = {};
  try {
    if (existsSync(fp)) current = JSON.parse(readFileSync(fp, "utf8")) ?? {};
  } catch {
    current = {};
  }
  // A JSON primitive ("x", 42) survives the ?? {} and current[key]= would
  // throw a 500 the client swallows — only an object merge makes sense.
  if (typeof current !== "object" || current === null || Array.isArray(current)) current = {};
  for (const key of ["name", "affiliation", "focus", "scholar", "affiliation_logo"] as const) {
    const v = fields[key];
    if (typeof v === "string") {
      const t = v.trim();
      if (t === "") delete current[key];
      else current[key] = t;
    }
  }
  mkdirSync(path.dirname(fp), { recursive: true });
  writeFileSync(fp, JSON.stringify(current, null, 2) + "\n");
  cache = undefined; // next profileResponse() re-reads
  return profileResponse();
}

export function profileBody(input: {
  profileFile: string;
  mountsFile: string;
  problemsRoot: string;
  runsRoot: string;
  memoryDirs: string[];
}): string {
  let profile: any = {};
  try {
    if (existsSync(input.profileFile)) profile = readJson(input.profileFile) ?? {};
  } catch {
    profile = {};
  }

  const name =
    (typeof profile.name === "string" && profile.name.trim()) || nameFromMounts(input.mountsFile) || "Practitioner";
  const mix = platformMix(input.problemsRoot);
  const stats = runStats(input.runsRoot);
  const you = {
    name,
    affiliation: typeof profile.affiliation === "string" ? profile.affiliation : null,
    scholar: typeof profile.scholar === "string" ? profile.scholar : null,
    affiliation_logo: typeof profile.affiliation_logo === "string" ? profile.affiliation_logo : null,
    focus: typeof profile.focus === "string" ? profile.focus : null,
    avatar: typeof profile.avatar === "string" ? profile.avatar : null,
    platforms: mix.map((p) => p.key),
    stats: {
      problems: countProblems(input.problemsRoot),
      runs: stats.runs,
      best_fidelity: stats.best_fidelity,
      since: stats.since,
    },
    remembers: remembers(input.memoryDirs, 3),
  };
  return JSON.stringify({ ok: true, you, error: null });
}

// --- cached entrypoint (never reject; body is a JSON string) ---
let cache: { at: number; body: string } | undefined;
export function profileResponse(): string {
  if (cache && Date.now() - cache.at < 10_000) return cache.body;
  let body: string;
  try {
    body = profileBody({
      profileFile: profileFile(),
      mountsFile: mountsFile(),
      problemsRoot: problemsRoot(),
      runsRoot: runsRoot(),
      memoryDirs: memoryDirs(),
    });
  } catch (err) {
    body = synthesizeProfile("bad_output", String(err));
  }
  cache = { at: Date.now(), body };
  return body;
}
