// releases.ts (service) — #2001: the What's-new landing page's content route.
//
//   GET /amicode/releases?since=<version> → the release cards to show between
//                                           the caller's last-seen version and
//                                           this build, newest first, plus the
//                                           "new for you" model arrivals
//
// THE CONTENT is docs/releases/<version>.md — YAML front matter
// {version, date, highlights: [{title, body}], links: {notes}} + an optional
// markdown body — copied into the VSIX at build (esbuild.config.mjs →
// dist/releases), so the page works offline; hub web clients read the SAME
// files through the same route on the hub's service.
//
// THE SELECTION (pure, below): no `since` = a fresh install → a short welcome,
// never the full history; since === current → nothing; otherwise every card
// with since < version ≤ current (a lane PRERELEASE build has no upper bound —
// it previews the notes of the release it is becoming).
//
// "NEW FOR YOU" (#2000 seam): models ok NOW whose first_ok_at (the
// reachability cache, model_reachability.ts) is after the last-seen version's
// release date. No dated baseline → no section (never the whole catalog).
//
// Same service discipline as the sibling families: one success shape,
// ok:false + a FIXED "code: detail" string (nothing the caller sent is
// echoed), tolerant reads (a malformed file is skipped, never fatal).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AmicodeServiceServer } from "./server";

export interface ReleaseHighlight {
  title: string;
  body: string;
}

export interface ReleaseCard {
  version: string;
  /** YYYY-MM-DD. */
  date: string;
  highlights: ReleaseHighlight[];
  links: { notes: string | null };
  /** The optional markdown body (trimmed; "" when absent). */
  body: string;
}

export interface NewForYouModel {
  provider: string;
  model: string;
  first_ok_at: number;
}

export interface WhatsNewSelection {
  show: boolean;
  welcome: boolean;
  cards: ReleaseCard[];
}

/** The reachability rows the arrivals read (a structural subset of
 *  model_reachability's ReachabilityRow — kept loose so a fake is trivial). */
export interface ArrivalRow {
  provider: string;
  model: string;
  status: string;
  first_ok_at?: number | null;
}

export interface ReleasesDeps {
  /** The bundled releases dir. Default: resolveReleasesDir(). */
  dir?: string;
  /** This build's version. Default: the extension package.json's. */
  version?: string;
  /** The live reachability rows (the GET /amicode/model-reachability body).
   *  undefined / throwing = no arrivals section. */
  reachability?: () => Promise<{ models: ArrivalRow[] }>;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const VERSION_MAX = 64;

interface ParsedVersion {
  core: [number, number, number];
  pre: string | null;
}

function parseVersion(v: string): ParsedVersion | undefined {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

export const isVersion = (v: unknown): v is string =>
  typeof v === "string" && v.length <= VERSION_MAX && parseVersion(v) !== undefined;

/** Semver order: cores numerically; a prerelease sorts below its release;
 *  prerelease identifiers compare numerically where both are numbers. An
 *  unparseable side compares as string (never throws). */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const xa = pa.pre.split(".");
  const xb = pb.pre.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s) ? Number(s) : NaN;
    const nt = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!Number.isNaN(ns) && !Number.isNaN(nt)) {
      if (ns !== nt) return ns - nt;
    } else if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (v: string): boolean => parseVersion(v)?.pre != null;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse one docs/releases/<v>.md. undefined = malformed (skipped by the
 *  loader): no front matter, bad YAML, a missing/non-semver version, a missing
 *  date, or highlights that are not a list of {title, body} strings. */
export function parseReleaseFile(text: string): ReleaseCard | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return undefined;
  }
  if (!isObj(fm)) return undefined;
  const version = typeof fm.version === "number" ? String(fm.version) : fm.version;
  if (!isVersion(version)) return undefined;
  const date = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : fm.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (!Array.isArray(fm.highlights)) return undefined;
  const highlights: ReleaseHighlight[] = [];
  for (const h of fm.highlights as unknown[]) {
    if (!isObj(h) || typeof h.title !== "string" || h.title.trim() === "") return undefined;
    highlights.push({ title: h.title.trim(), body: typeof h.body === "string" ? h.body.trim() : "" });
  }
  const notes = isObj(fm.links) && typeof fm.links.notes === "string" && /^https:\/\//.test(fm.links.notes) ? fm.links.notes : null;
  return { version: version.replace(/^v/, ""), date, highlights, links: { notes }, body: m[2]!.trim() };
}

/** Every well-formed *.md in `dir`, newest first. A missing dir → []. */
export function loadReleaseCards(dir: string): ReleaseCard[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const cards: ReleaseCard[] = [];
  for (const name of names) {
    try {
      const c = parseReleaseFile(readFileSync(path.join(dir, name), "utf8"));
      if (c) cards.push(c);
    } catch {
      /* unreadable → skipped */
    }
  }
  return cards.sort((a, b) => compareVersions(b.version, a.version));
}

/** The cards between `since` (exclusive) and `current` (inclusive). */
export function selectReleaseCards(
  cards: ReleaseCard[],
  opts: { since: string | null; current: string },
): WhatsNewSelection {
  if (opts.since === null) return { show: true, welcome: true, cards: [] };
  if (opts.since.replace(/^v/, "") === opts.current.replace(/^v/, "")) return { show: false, welcome: false, cards: [] };
  const since = opts.since;
  const open = isPrerelease(opts.current);
  const picked = cards
    .filter((c) => compareVersions(c.version, since) > 0 && (open || compareVersions(c.version, opts.current) <= 0))
    .sort((a, b) => compareVersions(b.version, a.version));
  return { show: picked.length > 0, welcome: false, cards: picked };
}

/** The last-seen version's timestamp: its release date, else the newest
 *  release at or below it; a version that is the prerelease of a release
 *  with no older dated card has no baseline (null). */
export function releaseBaselineMs(cards: ReleaseCard[], since: string | null): number | null {
  if (since === null) return null;
  const at = cards
    .filter((c) => compareVersions(c.version, since) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!at) return null;
  const ms = Date.parse(`${at.date}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Models ok now whose first ok is after the baseline (oldest arrival last). */
export function newForYouModels(rows: ArrivalRow[], baselineMs: number | null): NewForYouModel[] {
  if (baselineMs === null) return [];
  return rows
    .filter((r) => r.status === "ok" && typeof r.first_ok_at === "number" && r.first_ok_at > baselineMs)
    .map((r) => ({ provider: r.provider, model: r.model, first_ok_at: r.first_ok_at as number }))
    .sort((a, b) => b.first_ok_at - a.first_ok_at || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

// ── bundled-file + version resolution ──────────────────────────────────────
// __dirname is native in the CJS extension bundle (dist/) and shimmed by the
// ESM runner bundle's banner (bin/dist/); under vitest it is src/amicode_service.
function moduleDir(): string {
  return typeof __dirname === "string" ? __dirname : process.cwd();
}

/** The bundled releases dir: $AMICODE_RELEASES_DIR, else <here>/releases
 *  (dist/releases beside the extension bundle, or bin/dist/releases beside the
 *  runner bundle — #2017: a hub deploy copies the runner + its releases/ only),
 *  else dist/releases from bin/dist, else the repo's docs/releases (a dev
 *  checkout). undefined → no cards (the route still answers). */
export function resolveReleasesDir(env: NodeJS.ProcessEnv = process.env, here: string = moduleDir()): string | undefined {
  const override = env.AMICODE_RELEASES_DIR;
  if (typeof override === "string" && override.trim() !== "") return override;
  const candidates = [
    path.resolve(here, "releases"), // dist/ → dist/releases; bin/dist/ → bin/dist/releases
    path.resolve(here, "..", "..", "dist", "releases"), // bin/dist/ → dist/releases
    path.resolve(here, "..", "..", "..", "docs", "releases"), // dist/ in a checkout
    path.resolve(here, "..", "..", "..", "..", "docs", "releases"), // src/amicode_service or bin/dist in a checkout
  ];
  return candidates.find((c) => existsSync(c));
}

/** The build-time version esbuild bakes into BOTH the extension and the runner
 *  bundle (#2017). Guarded so vitest (no define) sees undefined, not a
 *  ReferenceError. */
function definedVersion(): string | undefined {
  return typeof __AMICODE_VERSION__ === "string" ? __AMICODE_VERSION__ : undefined;
}

export interface ResolveOwnVersionOpts {
  env?: NodeJS.ProcessEnv;
  /** The bundle's dir (the package.json walk starts here). Default: moduleDir(). */
  here?: string;
  /** The build-time define. Default: __AMICODE_VERSION__ when defined. */
  defined?: string | undefined;
}

const cachedByDir = new Map<string, string>();
/** The extension's own version: $AMICODE_VERSION, else the build-time define,
 *  else its package.json (name "amicode") near the bundle, else "0.0.0".
 *  (#2017: the hub's standalone runner has no package.json near it — the
 *  define is what keeps it from answering 0.0.0 and filtering every card.) */
export function resolveOwnVersion(opts: ResolveOwnVersionOpts = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.AMICODE_VERSION?.trim();
  if (fromEnv && isVersion(fromEnv)) return fromEnv.replace(/^v/, "");
  const defined = "defined" in opts ? opts.defined : definedVersion();
  if (defined && isVersion(defined)) return defined.replace(/^v/, "");
  const here = opts.here ?? moduleDir();
  const cached = cachedByDir.get(here);
  if (cached) return cached;
  for (const rel of [[".."], ["..", ".."], ["..", "..", ".."]]) {
    try {
      const pkg = JSON.parse(readFileSync(path.resolve(here, ...rel, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "amicode" && isVersion(pkg.version)) {
        cachedByDir.set(here, pkg.version);
        return pkg.version;
      }
    } catch {
      /* next candidate */
    }
  }
  return "0.0.0";
}

// ── the route ──────────────────────────────────────────────────────────────
/** GET /amicode/releases?since=<v>. Never throws. */
export async function releasesResponse(query: { since?: string | null }, deps: ReleasesDeps = {}): Promise<string> {
  const raw = query.since;
  const since = raw === undefined || raw === null || raw.trim() === "" ? null : raw.trim();
  if (since !== null && !isVersion(since))
    return JSON.stringify({ ok: false, error: "bad_request: since must be a version (e.g. 0.3.10)" });
  const current = deps.version ?? resolveOwnVersion();
  const dir = deps.dir ?? resolveReleasesDir();
  const cards = dir ? loadReleaseCards(dir) : [];
  const sel = selectReleaseCards(cards, { since, current });
  let models: NewForYouModel[] = [];
  if (sel.show && !sel.welcome && deps.reachability) {
    try {
      models = newForYouModels((await deps.reachability()).models ?? [], releaseBaselineMs(cards, since));
    } catch {
      models = [];
    }
  }
  return JSON.stringify({
    ok: true,
    current,
    since,
    show: sel.show,
    welcome: sel.welcome,
    cards: sel.cards,
    new_for_you: { models },
    error: null,
  });
}

export function registerReleasesRoutes(server: AmicodeServiceServer, deps: ReleasesDeps = {}): AmicodeServiceServer {
  server.add("GET", "/amicode/releases", async ({ url }) => ({
    body: await releasesResponse({ since: url.searchParams.get("since") }, deps),
  }));
  return server;
}
