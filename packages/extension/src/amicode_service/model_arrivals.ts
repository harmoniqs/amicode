// model_arrivals.ts (service) — #2000: model ARRIVALS. The catalog (models.dev,
// refreshed hourly by the engine) learns about new models and the reachability
// cache (#1985) probes daily, but nobody was TOLD when something new appeared.
// This module closes that: on every scheduler pass it diffs each CONNECTED
// provider's catalog ids against a persisted snapshot, probes the new ids at
// once (through the reachability cache's own rate-limit claim), and records an
// arrival event the picker ("New" tag) and the What's-new page read.
//
//   GET  /amicode/model-arrivals        → {ok, arrivals[], unseen, collapsed, error}
//   POST /amicode/model-arrivals/seen   → {ids} → {ok, marked, error}
//
// FILES (siblings of model-reachability.json — the SAME resolver, so they
// travel together whatever the ops-dir default is, #1998):
//   model-catalog-snapshot.json   {version, providers: {pid: [model ids]}}
//   model-arrivals.json           {version, events: [Arrival]}
//
// RULES (the issue's):
//  - A provider's first snapshot is a silent BASELINE — no events (a newly
//    connected provider is not an arrival flood). The snapshot never forgets
//    an id (union), so a flapping catalog fetch cannot re-announce; deleting
//    an id from the file re-announces it once (the hub verification step).
//  - Only the NEW ids are probed, via ModelReachability.probeSubset — the same
//    per-provider floor as every other trigger. A refused/failed probe leaves
//    the ids PENDING (out of the snapshot) so the next pass retries; nothing
//    is announced on a guess.
//  - us./global./eu./apac. variants of one base id announce ONCE (the
//    representative is the callable variant when there is one).
//  - WATCHLIST (`model.watch` globs in model-picker.json) matches across ALL
//    providers' catalogs, connected or not; a hit on an unconnected provider
//    is announced as "listed" with the reason. A watch hit is announced once
//    per (provider, base id).
//  - kind: ok → available; Bedrock denied → needs-allowlist (the aws-infra
//    IAM list); Bedrock "not available for this account"/Marketplace →
//    needs-agreement; everything else → listed.
//  - The GET returns at most MAX_UNSEEN unseen events (newest first); the rest
//    are summarised in `collapsed`.
// Same service discipline as the sibling families: one success shape, FIXED
// ok:false strings, tolerant reads that fail safe.
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogInfo, CatalogModelMeta, ModelReachability, ReachabilityStatus } from "./model_reachability";
import { readWatchGlobs } from "./model_picker_config";

export type ArrivalKind = "available" | "needs-allowlist" | "needs-agreement" | "listed";

export interface Arrival {
  /** `${provider}/${base id}` — stable across the regional variants. */
  id: string;
  provider: string;
  /** The representative catalog id (the callable variant when there is one). */
  model: string;
  status: ReachabilityStatus;
  kind: ArrivalKind;
  reason: string | null;
  first_seen_at: number;
  seen: boolean;
  watch: boolean;
  /** USD per Mtok from the catalog, when present. */
  price: { input?: number; output?: number } | null;
  context: number | null;
  latency_ms: number | null;
}

export const MAX_UNSEEN = 20;
const MAX_EVENTS = 200;
const MAX_SEEN_RETURNED = 100;
const MAX_SEEN_IDS = 500;
const ID_MAX = 300;
const REASON_MAX = 300;

const REGION_PREFIX = /^(?:us-gov|us|eu|apac|ap|global|jp|au|ca)\./;
/** "us.anthropic.claude-x" → "anthropic.claude-x"; ids without a regional
 *  inference prefix are their own base. */
export function baseModelId(id: string): string {
  return id.replace(REGION_PREFIX, "");
}

/** `*` and `?` globs, case-insensitive, whole-string; every other character
 *  is literal. */
export function globMatches(glob: string, text: string): boolean {
  const re = glob
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`, "i").test(text);
}

/** What a watch glob is matched against: the raw id, the base id, the base
 *  with a Bedrock-style vendor segment ("google.") stripped, and — for globs
 *  containing "/" — the provider-qualified forms. */
export function watchMatches(globs: readonly string[], provider: string, model: string): boolean {
  const base = baseModelId(model);
  const vendorless = /^[a-z]+\./.test(base) ? base.slice(base.indexOf(".") + 1) : base;
  const forms = [model, base, vendorless];
  return globs.some((g) =>
    g.includes("/") ? forms.some((f) => globMatches(g, `${provider}/${f}`)) : forms.some((f) => globMatches(g, f)),
  );
}

const isBedrock = (provider: string) => /bedrock/i.test(provider);

export function arrivalKind(provider: string, status: ReachabilityStatus, reason: string | null): ArrivalKind {
  if (status === "ok") return "available";
  if (isBedrock(provider)) {
    if (/not available for this account|marketplace|agreement|subscri/i.test(reason ?? "")) return "needs-agreement";
    if (status === "denied") return "needs-allowlist";
  }
  return "listed";
}

// ── persistence ────────────────────────────────────────────────────────────
interface SnapshotDoc {
  version: 1;
  providers: Record<string, string[]>;
}
interface EventsDoc {
  version: 1;
  events: Arrival[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseSnapshot(text: string | undefined): SnapshotDoc {
  const doc: SnapshotDoc = { version: 1, providers: {} };
  if (text === undefined) return doc;
  try {
    const raw = JSON.parse(text);
    if (isObj(raw) && isObj(raw.providers))
      for (const [pid, ids] of Object.entries(raw.providers))
        if (Array.isArray(ids)) doc.providers[pid] = ids.filter((i): i is string => typeof i === "string");
  } catch {
    /* a torn/garbage snapshot reads as "no snapshot" → silent re-baseline */
  }
  return doc;
}

const KINDS: readonly ArrivalKind[] = ["available", "needs-allowlist", "needs-agreement", "listed"];
const STATUSES: readonly string[] = ["ok", "denied", "unavailable", "invalid", "rate-limited", "error", "unchecked"];

function parseEvents(text: string | undefined): EventsDoc {
  const doc: EventsDoc = { version: 1, events: [] };
  if (text === undefined) return doc;
  try {
    const raw = JSON.parse(text);
    if (!isObj(raw) || !Array.isArray(raw.events)) return doc;
    for (const e of raw.events) {
      if (!isObj(e) || typeof e.id !== "string" || typeof e.provider !== "string" || typeof e.model !== "string") continue;
      const first = numOrNull(e.first_seen_at);
      if (first === null || !KINDS.includes(e.kind as ArrivalKind) || !STATUSES.includes(e.status as string)) continue;
      const price = isObj(e.price)
        ? {
            ...(numOrNull(e.price.input) !== null ? { input: e.price.input as number } : {}),
            ...(numOrNull(e.price.output) !== null ? { output: e.price.output as number } : {}),
          }
        : null;
      doc.events.push({
        id: e.id,
        provider: e.provider,
        model: e.model,
        status: e.status as ReachabilityStatus,
        kind: e.kind as ArrivalKind,
        reason: typeof e.reason === "string" ? e.reason : null,
        first_seen_at: first,
        seen: e.seen === true,
        watch: e.watch === true,
        price,
        context: numOrNull(e.context),
        latency_ms: numOrNull(e.latency_ms),
      });
    }
  } catch {
    /* unreadable → empty */
  }
  return doc;
}

async function readText(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ── the engine ─────────────────────────────────────────────────────────────
export interface ModelArrivalsDeps {
  reachability: ModelReachability;
  now?: () => number;
  /** Override the snapshot / events files (default: siblings of the
   *  reachability cache file). */
  snapshotFile?: string;
  eventsFile?: string;
}

interface Group {
  provider: string;
  base: string;
  ids: string[];
  watch: boolean;
  /** true = a snapshot diff (re-announces over an existing event); false = a
   *  watch-only hit (announced once). */
  fromDiff: boolean;
}

export class ModelArrivals {
  readonly snapshotFile: string;
  readonly eventsFile: string;
  private readonly mr: ModelReachability;
  private readonly deps: ModelArrivalsDeps;

  constructor(deps: ModelArrivalsDeps) {
    this.deps = deps;
    this.mr = deps.reachability;
    const dir = path.dirname(this.mr.file);
    this.snapshotFile = deps.snapshotFile ?? path.join(dir, "model-catalog-snapshot.json");
    this.eventsFile = deps.eventsFile ?? path.join(dir, "model-arrivals.json");
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The arrivals pass (the reachability scheduler's tick hook). Never throws
   *  past the hook's own guard. */
  async pass(): Promise<void> {
    const { listCatalog, getWatch } = this.mr.catalogDeps;
    if (!listCatalog) return;
    let info: CatalogInfo | undefined;
    try {
      info = await listCatalog();
    } catch {
      info = undefined;
    }
    if (!info || !isObj(info.providers)) return;
    let globs: string[] = [];
    try {
      globs = (getWatch ?? readWatchGlobs)();
    } catch {
      globs = [];
    }
    const connected = new Set(info.connected);
    const snap = parseSnapshot(await readText(this.snapshotFile));

    // 1. candidate groups (per provider, grouped by base id)
    const groups = new Map<string, Group>();
    for (const [pid, models] of Object.entries(info.providers)) {
      const ids = Object.keys(models).sort();
      const isConnected = connected.has(pid);
      const prev = isConnected ? snap.providers[pid] : undefined;
      const prevSet = new Set(prev ?? []);
      const prevBases = new Set((prev ?? []).map(baseModelId));
      for (const id of ids) {
        const base = baseModelId(id);
        const watched = globs.length > 0 && watchMatches(globs, pid, id);
        const isNewId = isConnected && prev !== undefined && !prevSet.has(id);
        const diffNew = isNewId && !prevBases.has(base);
        if (!diffNew && !watched) continue;
        const key = `${pid}/${base}`;
        const g = groups.get(key) ?? { provider: pid, base, ids: [], watch: false, fromDiff: false };
        g.ids.push(id);
        g.watch ||= watched;
        g.fromDiff ||= diffNew;
        groups.set(key, g);
      }
    }

    // 2. resolve a verdict per group (probe the connected ones' new ids)
    const existing = parseEvents(await readText(this.eventsFile));
    const have = new Set(existing.events.map((e) => e.id));
    const decided: Array<{ group: Group; event: Arrival }> = [];
    const pending = new Set<string>(); // `${pid}\0${id}` left out of the snapshot
    const toProbe = new Map<string, string[]>();
    for (const g of groups.values()) {
      if (!g.fromDiff && have.has(`${g.provider}/${g.base}`)) continue; // watch hit already announced
      if (!connected.has(g.provider)) continue;
      const need = g.ids.filter((id) => this.mr.cachedRow(g.provider, id).status === "unchecked");
      if (need.length > 0) toProbe.set(g.provider, [...(toProbe.get(g.provider) ?? []), ...need]);
    }
    for (const [pid, ids] of toProbe) {
      const ok = await this.mr.probeSubset(pid, ids);
      if (!ok) for (const id of ids) pending.add(`${pid}\0${id}`);
    }
    const nowMs = this.now();
    for (const g of groups.values()) {
      const key = `${g.provider}/${g.base}`;
      if (!g.fromDiff && have.has(key)) continue;
      const meta = (id: string): CatalogModelMeta | undefined => info!.providers[g.provider]?.[id];
      if (!connected.has(g.provider)) {
        const rep = g.ids[0]!;
        decided.push({
          group: g,
          event: this.event(g, rep, "unchecked", "provider not connected", null, meta(rep), nowMs),
        });
        continue;
      }
      if (g.ids.some((id) => pending.has(`${g.provider}\0${id}`))) continue; // retry next pass
      const rows = g.ids.map((id) => this.mr.cachedRow(g.provider, id));
      // an id the probe returned no row for (not probeable) is skipped
      const probed = rows.filter((r) => r.status !== "unchecked");
      if (probed.length === 0) {
        // nothing the probe could vouch for: a watch hit is still announced
        // (listed, unchecked); a bare diff hit is recorded silently
        if (g.watch) {
          const rep = g.ids[0]!;
          decided.push({ group: g, event: this.event(g, rep, "unchecked", "not probed yet", null, meta(rep), nowMs) });
        }
        continue;
      }
      const rep = probed.find((r) => r.status === "ok") ?? probed[0]!;
      decided.push({
        group: g,
        event: this.event(g, rep.model, rep.status, rep.reason, rep.latency_ms, meta(rep.model), nowMs),
      });
    }

    // 3. commit under the lock (re-read: another hub shard may have committed)
    await this.mr.withLock("arrivals", async () => {
      const snapNow = parseSnapshot(await readText(this.snapshotFile));
      const evNow = parseEvents(await readText(this.eventsFile));
      const announced = new Set<string>();
      for (const { group, event } of decided) {
        const prevIds = new Set(snapNow.providers[group.provider] ?? []);
        // another shard already took this diff (its ids are in the snapshot)
        if (group.fromDiff && group.ids.some((id) => prevIds.has(id))) continue;
        const i = evNow.events.findIndex((e) => e.id === event.id);
        if (i >= 0) {
          if (!group.fromDiff) continue;
          evNow.events.splice(i, 1); // a re-announce replaces (seen resets)
        }
        evNow.events.push(event);
        announced.add(event.id);
      }
      evNow.events.sort((a, b) => b.first_seen_at - a.first_seen_at || a.id.localeCompare(b.id));
      evNow.events.length = Math.min(evNow.events.length, MAX_EVENTS);
      for (const [pid, models] of Object.entries(info!.providers)) {
        if (!connected.has(pid)) continue;
        const keep = Object.keys(models).filter((id) => !pending.has(`${pid}\0${id}`));
        snapNow.providers[pid] = [...new Set([...(snapNow.providers[pid] ?? []), ...keep])].sort();
      }
      await writeAtomic(this.snapshotFile, snapNow);
      if (announced.size > 0) await writeAtomic(this.eventsFile, evNow);
    });
  }

  private event(
    g: Group,
    model: string,
    status: ReachabilityStatus,
    reason: string | null,
    latency: number | null,
    meta: CatalogModelMeta | undefined,
    at: number,
  ): Arrival {
    const price =
      meta && (meta.input !== undefined || meta.output !== undefined)
        ? { ...(meta.input !== undefined ? { input: meta.input } : {}), ...(meta.output !== undefined ? { output: meta.output } : {}) }
        : null;
    return {
      id: `${g.provider}/${g.base}`,
      provider: g.provider,
      model,
      status,
      kind: arrivalKind(g.provider, status, reason),
      reason: reason === null ? null : reason.slice(0, REASON_MAX),
      first_seen_at: at,
      seen: false,
      watch: g.watch,
      price,
      context: meta?.context ?? null,
      latency_ms: latency,
    };
  }

  /** The GET body's data: all unseen (capped) + the recent seen. */
  async list(): Promise<{ arrivals: Arrival[]; unseen: number; collapsed: number }> {
    const doc = parseEvents(await readText(this.eventsFile));
    const sorted = [...doc.events].sort((a, b) => b.first_seen_at - a.first_seen_at || a.id.localeCompare(b.id));
    const unseen = sorted.filter((e) => !e.seen);
    const seen = sorted.filter((e) => e.seen).slice(0, MAX_SEEN_RETURNED);
    const shown = unseen.slice(0, MAX_UNSEEN);
    const arrivals = [...shown, ...seen].sort((a, b) => b.first_seen_at - a.first_seen_at || a.id.localeCompare(b.id));
    return { arrivals, unseen: unseen.length, collapsed: unseen.length - shown.length };
  }

  /** Mark events seen; returns how many existing, previously-unseen events changed. */
  async markSeen(ids: string[]): Promise<number> {
    const want = new Set(ids);
    return this.mr.withLock("arrivals", async () => {
      const doc = parseEvents(await readText(this.eventsFile));
      let n = 0;
      for (const e of doc.events)
        if (want.has(e.id) && !e.seen) {
          e.seen = true;
          n++;
        }
      if (n > 0) await writeAtomic(this.eventsFile, doc);
      return n;
    });
  }
}

// ── the route bodies ───────────────────────────────────────────────────────
const synthesize = (error: string): string => JSON.stringify({ ok: false, error });

/** GET /amicode/model-arrivals. Never throws. */
export async function modelArrivalsResponse(a: ModelArrivals): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await a.list()), error: null });
  } catch {
    return synthesize("arrivals_unavailable: the model-arrivals store could not be read");
  }
}

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

/** POST /amicode/model-arrivals/seen — {ids: string[]}. */
export async function markSeenResponse(body: unknown, a: ModelArrivals): Promise<string> {
  const parsed = parseBody(body);
  const ids = parsed?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_SEEN_IDS ||
    !ids.every((i) => typeof i === "string" && i !== "" && i.length <= ID_MAX)
  )
    return synthesize("bad_request: body must be JSON {ids: string[]} (at most 500)");
  try {
    return JSON.stringify({ ok: true, marked: await a.markSeen(ids as string[]), error: null });
  } catch {
    return synthesize("arrivals_unavailable: the model-arrivals store could not be locked");
  }
}
