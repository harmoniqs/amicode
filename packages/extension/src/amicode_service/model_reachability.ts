// model_reachability.ts (service) — #1985 (#1979 S2): the model-reachability
// cache, its rate-limited scheduler, and the route family.
//
//   GET  /amicode/model-reachability          → per-(provider, model) rows +
//                                               per-provider probe metadata
//   POST /amicode/model-reachability/refresh  → {provider?} — on-demand probe,
//                                               rate-limited per provider
//   POST /amicode/model-reachability/demote   → {provider, model, status,
//                                               reason} — a runtime demotion
//                                               that sticks until the next probe
//
// THE PROBE is the engine's (S1, #1984: POST /provider/probe — one token per
// model through the engine's own credentials; only a named status, latency, a
// redacted reason and a non-secret credential fingerprint cross). This module
// decides WHEN to call it and remembers what it said.
//
// THE CACHE is one JSON file under AMICODE_OPS_DIR (the routingSnapshotFile
// convention), SHARED by every hub shard on the machine: every write is a
// read-modify-write under a mkdir lock (atomic EEXIST on contention — the
// distill_queue idiom; a dead owner's lock is reclaimed after the stale
// window) and lands by tmp+rename, so readers never see a torn file and two
// writers never lose each other's update. The rate-limit CLAIM is taken under
// the same lock, so N shards probing on the same schedule probe once.
//
// SEMANTICS (the issue's binding rules):
//  - Keyed {provider, model, credential_fp}: a probe that returns a NEW
//    fingerprint for a provider drops every row cached under the old one, and
//    a row whose fp disagrees with its provider's current fp is served as
//    "unchecked". A credential change never inherits the old verdicts.
//  - Unknown is "unchecked", NEVER ok: a catalog model without a valid cached
//    row is reported unchecked; with no catalog and no cache nothing is
//    invented.
//  - A demotion sticks until the next probe of that model replaces it.
//  - Rate limit: every trigger (scheduler, on-connect, on-demand) respects a
//    per-provider floor between probe ATTEMPTS (a failed probe counts — never
//    hammer a dead engine). The scheduler additionally probes only a provider
//    that was never probed (on-connect) or whose last probe is a day old.
//
// Same service discipline as the posture / model-routing families: one success
// shape per route, ok:false + "code: detail" with FIXED strings (nothing the
// caller sent is echoed), tolerant reads that fail safe.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fetchProviderModels, probeProviderModels } from "../llm_creds.mjs";

export type ProbeStatus = "ok" | "denied" | "unavailable" | "invalid" | "rate-limited" | "error";
export type ReachabilityStatus = ProbeStatus | "unchecked";

const PROBE_STATUSES: readonly ProbeStatus[] = ["ok", "denied", "unavailable", "invalid", "rate-limited", "error"];
/** A demotion names a FAILURE — "ok" is only ever a probe's word. */
const DEMOTE_STATUSES: readonly ProbeStatus[] = ["denied", "unavailable", "invalid", "rate-limited", "error"];

/** One row of the engine's POST /provider/probe response (#1984). */
export interface ProbeResult {
  model: string;
  status: ProbeStatus;
  latency_ms: number;
  reason: string | null;
  credential_fp: string | null;
  checked_at: number;
}

export interface ProbeOutput {
  providerID: string;
  results: ProbeResult[];
}

export interface ModelReachabilityDeps {
  /** The cache file. Default: $AMICODE_OPS_DIR/model-reachability.json. */
  file?: string;
  /** Clock (epoch ms). */
  now?: () => number;
  /** The live provider → model-id catalog (key-free). undefined/throwing =
   *  unknown — never read as "no providers". */
  listModels?: () => Promise<Record<string, string[]> | undefined>;
  /** The engine probe (S1). undefined/throwing = the probe failed. */
  probe?: (providerID: string, modelIDs: string[]) => Promise<ProbeOutput | undefined>;
  /** Floor between probe attempts of one provider, any trigger. Default 5 min. */
  minProbeIntervalMs?: number;
  /** The scheduler's re-probe age. Default 24 h. */
  dailyIntervalMs?: number;
  /** The scheduler's tick period (the route registration arms it). 0 = no
   *  scheduler (no timer, no GET-kick). Default 15 min. */
  schedulerIntervalMs?: number;
  /** The first tick after registration (the boot on-connect pass). Default 2 s. */
  schedulerInitialDelayMs?: number;
  /** A lock older than this whose owner pid is dead is reclaimed. Default 10 s. */
  staleLockMs?: number;
  /** Give up acquiring the lock after this long (the write fails, the route
   *  answers named). Default 10 s. */
  lockTimeoutMs?: number;
  log?: (line: string) => void;
}

interface CachedModel {
  status: ProbeStatus;
  reason: string | null;
  latency_ms: number | null;
  checked_at: number;
  credential_fp: string | null;
  source: "probe" | "demoted";
  /** #2001: when this model was FIRST seen ok on this credential (epoch ms);
   *  0 = ok since the provider's baseline probe (never an arrival); null =
   *  never ok. Feeds the What's-new page's "new for you" arrivals (#2000). */
  first_ok_at: number | null;
}

interface CachedProvider {
  credential_fp: string | null;
  last_probe_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  models: Record<string, CachedModel>;
}

interface CacheDoc {
  version: 1;
  providers: Record<string, CachedProvider>;
}

export interface ReachabilityRow {
  provider: string;
  model: string;
  status: ReachabilityStatus;
  reason: string | null;
  latency_ms: number | null;
  checked_at: number | null;
  credential_fp: string | null;
  source: "probe" | "demoted" | null;
  /** #2001: see CachedModel.first_ok_at. */
  first_ok_at: number | null;
}

export interface ReachabilityProviderMeta {
  provider: string;
  credential_fp: string | null;
  last_probe_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  next_probe_at: number;
}

export interface ReachabilitySnapshot {
  ok: true;
  models: ReachabilityRow[];
  providers: ReachabilityProviderMeta[];
  catalog_known: boolean;
  error: null;
}

export interface RefreshResult {
  ok: boolean;
  refreshed: string[];
  rate_limited: Array<{ provider: string; retry_after_ms: number }>;
  failed: Array<{ provider: string; error: string }>;
  models: ReachabilityRow[];
  error: string | null;
}

export type DemoteResult =
  | { ok: true; provider: string; model: string; status: ProbeStatus; reason: string | null; error: null }
  | { ok: false; error: string };

const PROBE_BATCH = 500; // the engine's PROBE_MAX_MODELS
const REASON_MAX = 300;
const ID_MAX = 256;

/** The cache file (the #864 ops-dir convention: $AMICODE_OPS_DIR → ~/.amico),
 *  beside model-routing-providers.json. */
export function reachabilityCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICODE_OPS_DIR;
  const dir = typeof v === "string" && v.trim() !== "" ? v : path.join(os.homedir(), ".amico");
  return path.join(dir, "model-reachability.json");
}

const emptyDoc = (): CacheDoc => ({ version: 1, providers: {} });
const emptyProvider = (): CachedProvider => ({
  credential_fp: null,
  last_probe_at: null,
  last_attempt_at: null,
  last_error: null,
  models: {},
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Tolerant parse: anything malformed degrades to "not cached" (→ unchecked),
 *  never to a fabricated verdict. */
function parseDoc(text: string | undefined): CacheDoc {
  if (text === undefined) return emptyDoc();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyDoc();
  }
  if (!isObj(raw) || !isObj(raw.providers)) return emptyDoc();
  const doc = emptyDoc();
  for (const [pid, pv] of Object.entries(raw.providers)) {
    if (!isObj(pv)) continue;
    const p: CachedProvider = {
      credential_fp: strOrNull(pv.credential_fp),
      last_probe_at: numOrNull(pv.last_probe_at),
      last_attempt_at: numOrNull(pv.last_attempt_at),
      last_error: strOrNull(pv.last_error),
      models: {},
    };
    if (isObj(pv.models)) {
      for (const [mid, mv] of Object.entries(pv.models)) {
        if (!isObj(mv)) continue;
        const status = mv.status;
        const checked = numOrNull(mv.checked_at);
        if (typeof status !== "string" || !(PROBE_STATUSES as readonly string[]).includes(status) || checked === null)
          continue;
        p.models[mid] = {
          status: status as ProbeStatus,
          reason: strOrNull(mv.reason),
          latency_ms: numOrNull(mv.latency_ms),
          checked_at: checked,
          credential_fp: strOrNull(mv.credential_fp),
          source: mv.source === "demoted" ? "demoted" : "probe",
          // a legacy row (pre-#2001) that is ok was there before tracking → 0
          first_ok_at: numOrNull(mv.first_ok_at) ?? (status === "ok" ? 0 : null),
        };
      }
    }
    doc.providers[pid] = p;
  }
  return doc;
}

/** Keep only well-formed probe rows (the engine is trusted, the wire is not). */
function validResults(out: ProbeOutput | undefined): ProbeResult[] | undefined {
  if (!out || !Array.isArray(out.results)) return undefined;
  const rows: ProbeResult[] = [];
  for (const r of out.results as unknown[]) {
    if (!isObj(r) || typeof r.model !== "string" || r.model === "") continue;
    if (typeof r.status !== "string" || !(PROBE_STATUSES as readonly string[]).includes(r.status)) continue;
    const fp = r.credential_fp;
    if (fp !== null && typeof fp !== "string") continue;
    rows.push({
      model: r.model,
      status: r.status as ProbeStatus,
      latency_ms: numOrNull(r.latency_ms) ?? 0,
      reason: typeof r.reason === "string" ? r.reason.slice(0, REASON_MAX) : null,
      credential_fp: fp as string | null,
      checked_at: numOrNull(r.checked_at) ?? Date.now(),
    });
  }
  return rows;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ModelReachability {
  readonly file: string;
  private readonly deps: ModelReachabilityDeps;
  private ticking: Promise<void> | undefined;

  constructor(deps: ModelReachabilityDeps = {}) {
    this.deps = deps;
    this.file = deps.file ?? reachabilityCacheFile();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private get floorMs(): number {
    return this.deps.minProbeIntervalMs ?? 5 * 60_000;
  }
  private get dailyMs(): number {
    return this.deps.dailyIntervalMs ?? 24 * 60 * 60_000;
  }
  get schedulerIntervalMs(): number {
    return this.deps.schedulerIntervalMs ?? 15 * 60_000;
  }
  /** The scheduler runs only when it has both engine seams. */
  get canSchedule(): boolean {
    return this.schedulerIntervalMs > 0 && this.deps.listModels !== undefined && this.deps.probe !== undefined;
  }

  // ── the shared-file lock ────────────────────────────────────────────────
  private readDocSync(): CacheDoc {
    if (!existsSync(this.file)) return emptyDoc();
    try {
      return parseDoc(readFileSync(this.file, "utf8"));
    } catch {
      return emptyDoc();
    }
  }

  private async acquire(lockDir: string): Promise<void> {
    const deadline = Date.now() + (this.deps.lockTimeoutMs ?? 10_000);
    const staleMs = this.deps.staleLockMs ?? 10_000;
    await mkdir(path.dirname(lockDir), { recursive: true });
    for (;;) {
      try {
        await mkdir(lockDir); // no recursive: EEXIST on contention is the lock
        await writeFile(path.join(lockDir, "owner"), JSON.stringify({ pid: process.pid, ts: Date.now() }) + "\n").catch(
          () => undefined,
        );
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      // Contended: reclaim a dead owner's lock past the stale window (or any
      // lock 10× past it — a critical section is milliseconds).
      let owner: { pid?: unknown; ts?: unknown } | undefined;
      try {
        owner = JSON.parse(await readFile(path.join(lockDir, "owner"), "utf8"));
      } catch {
        owner = undefined;
      }
      let ts = typeof owner?.ts === "number" ? owner.ts : undefined;
      if (ts === undefined) ts = await stat(lockDir).then((s) => s.mtimeMs, () => undefined);
      if (ts !== undefined) {
        const age = Date.now() - ts;
        if ((age > staleMs && !pidAlive(owner?.pid)) || age > staleMs * 10) {
          const aside = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
          try {
            await rename(lockDir, aside); // atomic: one reclaimer wins
            await rm(aside, { recursive: true, force: true });
            this.deps.log?.(`[model-reachability] reclaimed a stale cache lock`);
          } catch {
            /* another reclaimer won — retry the claim */
          }
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error("model-reachability cache lock timeout");
      await sleep(3 + Math.floor(Math.random() * 12));
    }
  }

  /** Read-modify-write under the lock; the write lands by tmp+rename. */
  private async update<T>(fn: (doc: CacheDoc) => T): Promise<T> {
    const lockDir = `${this.file}.lock`;
    await this.acquire(lockDir);
    try {
      const text = await readFile(this.file, "utf8").catch(() => undefined);
      const doc = parseDoc(text);
      const result = fn(doc);
      const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n");
        await rename(tmp, this.file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return result;
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────
  private async catalog(): Promise<Record<string, string[]> | undefined> {
    if (!this.deps.listModels) return undefined;
    try {
      const c = await this.deps.listModels();
      if (!isObj(c)) return undefined;
      const out: Record<string, string[]> = {};
      for (const [pid, models] of Object.entries(c)) {
        if (Array.isArray(models)) out[pid] = [...new Set(models.filter((m): m is string => typeof m === "string" && m !== ""))];
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private rowOf(doc: CacheDoc, provider: string, model: string): ReachabilityRow {
    const p = doc.providers[provider];
    const m = p?.models[model];
    // The key includes the fp: a row cached under another credential is not
    // a verdict about this one → unchecked.
    if (p === undefined || m === undefined || m.credential_fp !== p.credential_fp) {
      return { provider, model, status: "unchecked", reason: null, latency_ms: null, checked_at: null, credential_fp: null, source: null, first_ok_at: null };
    }
    return {
      provider,
      model,
      status: m.status,
      reason: m.reason,
      latency_ms: m.latency_ms,
      checked_at: m.checked_at,
      credential_fp: m.credential_fp,
      source: m.source,
      first_ok_at: m.first_ok_at,
    };
  }

  private metaOf(doc: CacheDoc, provider: string): ReachabilityProviderMeta {
    const p = doc.providers[provider] ?? emptyProvider();
    const floorAt = p.last_attempt_at !== null ? p.last_attempt_at + this.floorMs : 0;
    const dueAt = p.last_probe_at !== null ? p.last_probe_at + this.dailyMs : 0;
    return {
      provider,
      credential_fp: p.credential_fp,
      last_probe_at: p.last_probe_at,
      last_attempt_at: p.last_attempt_at,
      last_error: p.last_error,
      next_probe_at: Math.max(floorAt, dueAt, this.now()),
    };
  }

  private rows(doc: CacheDoc, catalog: Record<string, string[]> | undefined, only?: string[]): ReachabilityRow[] {
    const out: ReachabilityRow[] = [];
    const providers = (catalog ? Object.keys(catalog) : Object.keys(doc.providers)).filter((p) => !only || only.includes(p)).sort();
    for (const provider of providers) {
      const models = catalog ? catalog[provider] ?? [] : Object.keys(doc.providers[provider]?.models ?? {});
      for (const model of [...models].sort()) {
        const r = this.rowOf(doc, provider, model);
        // with no catalog, only serve what the cache can vouch for
        if (!catalog && r.status === "unchecked") continue;
        out.push(r);
      }
    }
    return out;
  }

  /** The GET body. Never throws. */
  async snapshot(): Promise<ReachabilitySnapshot> {
    const catalog = await this.catalog();
    const doc = this.readDocSync();
    const providers = (catalog ? Object.keys(catalog) : Object.keys(doc.providers)).sort();
    return {
      ok: true,
      models: this.rows(doc, catalog),
      providers: providers.map((p) => this.metaOf(doc, p)),
      catalog_known: catalog !== undefined,
      error: null,
    };
  }

  // ── probes ──────────────────────────────────────────────────────────────
  /** Take the rate-limit claim for each provider under the lock: a provider
   *  inside its floor is refused (with the wait); `due` filters the
   *  scheduler's triggers. Claimed providers get last_attempt_at = now. */
  private async claim(
    providers: string[],
    due?: (p: CachedProvider | undefined, now: number) => boolean,
  ): Promise<{ claimed: string[]; rate_limited: Array<{ provider: string; retry_after_ms: number }> }> {
    const now = this.now();
    return this.update((doc) => {
      const claimed: string[] = [];
      const rate_limited: Array<{ provider: string; retry_after_ms: number }> = [];
      for (const pid of providers) {
        const p = doc.providers[pid];
        if (due && !due(p, now)) continue;
        const since = p?.last_attempt_at != null ? now - p.last_attempt_at : Infinity;
        if (since < this.floorMs) {
          rate_limited.push({ provider: pid, retry_after_ms: this.floorMs - since });
          continue;
        }
        const entry = p ?? emptyProvider();
        entry.last_attempt_at = now;
        doc.providers[pid] = entry;
        claimed.push(pid);
      }
      return { claimed, rate_limited };
    });
  }

  /** Probe one claimed provider (batched at the engine's cap) and merge. */
  private async probeAndMerge(provider: string, models: string[]): Promise<boolean> {
    let results: ProbeResult[] | undefined = [];
    for (let i = 0; i < models.length && results !== undefined; i += PROBE_BATCH) {
      let out: ProbeOutput | undefined;
      try {
        out = await this.deps.probe?.(provider, models.slice(i, i + PROBE_BATCH));
      } catch {
        out = undefined;
      }
      const batch = validResults(out);
      results = batch === undefined ? undefined : [...results, ...batch];
    }
    const now = this.now();
    if (results === undefined) {
      await this.update((doc) => {
        const p = doc.providers[provider] ?? emptyProvider();
        p.last_error = "probe_failed";
        doc.providers[provider] = p;
      });
      return false;
    }
    const rows = results;
    await this.update((doc) => {
      const p = doc.providers[provider] ?? emptyProvider();
      const fp = rows.length > 0 ? rows[0]!.credential_fp : p.credential_fp;
      // #2001: the provider's first probe (or the first under a new credential)
      // is the BASELINE — what is ok there was already available, not an arrival.
      const baseline = p.last_probe_at === null || fp !== p.credential_fp;
      // The credential changed: nothing cached under the old one survives.
      if (fp !== p.credential_fp) p.models = {};
      p.credential_fp = fp;
      for (const r of rows) {
        const prior = p.models[r.model]?.first_ok_at ?? null;
        p.models[r.model] = {
          status: r.status,
          reason: r.reason,
          latency_ms: r.latency_ms,
          checked_at: r.checked_at,
          credential_fp: r.credential_fp,
          source: "probe",
          first_ok_at: prior ?? (r.status === "ok" ? (baseline ? 0 : r.checked_at) : null),
        };
      }
      p.last_probe_at = now;
      p.last_error = null;
      doc.providers[provider] = p;
    });
    return true;
  }

  /** On-demand refresh (one provider, or every catalog provider). */
  async refresh(opts: { provider?: string } = {}): Promise<RefreshResult> {
    const fail = (error: string): RefreshResult => ({ ok: false, refreshed: [], rate_limited: [], failed: [], models: [], error });
    if (!this.deps.probe) return fail("engine_unavailable: no engine probe is wired");
    const catalog = await this.catalog();
    if (catalog === undefined) return fail("engine_unavailable: the engine's provider catalog could not be read");
    const targets = opts.provider !== undefined ? [opts.provider] : Object.keys(catalog).sort();
    if (opts.provider !== undefined && !(opts.provider in catalog))
      return fail("bad_request: unknown or unconnected provider");
    let claim;
    try {
      claim = await this.claim(targets);
    } catch {
      return fail("cache_unavailable: the reachability cache could not be locked");
    }
    const refreshed: string[] = [];
    const failed: Array<{ provider: string; error: string }> = [];
    for (const pid of claim.claimed) {
      try {
        if (await this.probeAndMerge(pid, catalog[pid] ?? [])) refreshed.push(pid);
        else failed.push({ provider: pid, error: "probe_failed" });
      } catch {
        failed.push({ provider: pid, error: "cache_unavailable" });
      }
    }
    return {
      ok: true,
      refreshed,
      rate_limited: claim.rate_limited,
      failed,
      models: this.rows(this.readDocSync(), catalog, targets),
      error: null,
    };
  }

  /** The scheduler pass: probe every catalog provider that was never probed
   *  (on-connect) or whose last probe is a day old — inside the floor, never.
   *  In-process re-entry joins the running pass. Never throws. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      if (!this.deps.probe) return;
      const catalog = await this.catalog();
      if (catalog === undefined) return;
      const { claimed } = await this.claim(Object.keys(catalog).sort(), (p, now) =>
        p === undefined || p.last_probe_at === null ? true : now - p.last_probe_at >= this.dailyMs,
      );
      for (const pid of claimed) await this.probeAndMerge(pid, catalog[pid] ?? []);
    })()
      .catch((err) => this.deps.log?.(`[model-reachability] scheduler pass failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  /** Arm the scheduler (first pass after the initial delay, then every
   *  interval). Returns the stop. Timers are unref'd — never hold a process. */
  startScheduler(): () => void {
    if (!this.canSchedule) return () => undefined;
    const first = setTimeout(() => void this.tick(), this.deps.schedulerInitialDelayMs ?? 2000);
    const every = setInterval(() => void this.tick(), this.schedulerIntervalMs);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  /** A runtime demotion (e.g. a dispatch that hit 403/429): sticks until the
   *  next probe of that model replaces it. */
  async demote(body: { provider?: unknown; model?: unknown; status?: unknown; reason?: unknown }): Promise<DemoteResult> {
    const bad = (): DemoteResult => ({
      ok: false,
      error: "bad_request: body must be JSON {provider, model, status: denied|unavailable|invalid|rate-limited|error, reason?: string|null}",
    });
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (provider === "" || model === "" || provider.length > ID_MAX || model.length > ID_MAX) return bad();
    if (typeof body.status !== "string" || !(DEMOTE_STATUSES as readonly string[]).includes(body.status)) return bad();
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") return bad();
    const status = body.status as ProbeStatus;
    const reason = typeof body.reason === "string" ? body.reason.slice(0, REASON_MAX) : null;
    const now = this.now();
    try {
      await this.update((doc) => {
        const p = doc.providers[provider] ?? emptyProvider();
        const first_ok_at = p.models[model]?.first_ok_at ?? null;
        p.models[model] = { status, reason, latency_ms: null, checked_at: now, credential_fp: p.credential_fp, source: "demoted", first_ok_at };
        doc.providers[provider] = p;
      });
    } catch {
      return { ok: false, error: "cache_unavailable: the reachability cache could not be locked" };
    }
    return { ok: true, provider, model, status, reason, error: null };
  }
}

// ── the route bodies ──────────────────────────────────────────────────────
const synthesize = (error: string): string => JSON.stringify({ ok: false, error });

function parseBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === "string") {
    if (body.trim() === "") return {};
    try {
      const v = JSON.parse(body);
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }
  return isObj(body) ? body : undefined;
}

/** GET /amicode/model-reachability. Never throws. */
export async function modelReachabilityResponse(mr: ModelReachability): Promise<string> {
  try {
    return JSON.stringify(await mr.snapshot());
  } catch {
    return synthesize("cache_unavailable: the reachability cache could not be read");
  }
}

/** POST /amicode/model-reachability/refresh — {provider?}. */
export async function refreshModelReachabilityResponse(body: unknown, mr: ModelReachability): Promise<string> {
  const parsed = parseBody(body);
  if (parsed === undefined || (parsed.provider !== undefined && (typeof parsed.provider !== "string" || parsed.provider.trim() === "")))
    return synthesize("bad_request: body must be JSON {provider?: string}");
  const res = await mr.refresh(typeof parsed.provider === "string" ? { provider: parsed.provider.trim() } : {});
  return res.ok ? JSON.stringify(res) : synthesize(res.error ?? "error");
}

/** POST /amicode/model-reachability/demote — {provider, model, status, reason?}. */
export async function demoteModelReachabilityResponse(body: unknown, mr: ModelReachability): Promise<string> {
  const parsed = parseBody(body);
  if (parsed === undefined) return JSON.stringify(await mr.demote({}));
  return JSON.stringify(await mr.demote(parsed));
}

/** The production engine seams over the running engine (late-bound URL — the
 *  engine restarts under the service's feet): the key-free catalog
 *  (/config/providers) and the S1 probe (/provider/probe), via the same
 *  llm_creds client fetchProviderIds uses. */
export function engineReachabilityDeps(engine: {
  getUrl: () => string | undefined;
  headers?: Record<string, string>;
}): Pick<ModelReachabilityDeps, "listModels" | "probe"> {
  return {
    listModels: async () => {
      const url = engine.getUrl();
      return url ? fetchProviderModels(url, { headers: engine.headers }) : undefined;
    },
    probe: async (providerID, modelIDs) => {
      const url = engine.getUrl();
      return url ? probeProviderModels(url, providerID, modelIDs, { headers: engine.headers }) : undefined;
    },
  };
}
