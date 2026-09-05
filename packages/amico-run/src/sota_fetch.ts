// sota_fetch.ts — the ONE-FETCHER fetch flow (#820, spec spec-20260905-103000
// living-sota D4, the one-fetcher invariant / S6): every live fetch through
// the SOTA lenses rides
//
//   cache → queue lock → RE-CHECK cache → fetch → write cache → history
//
// so that (a) a second fetcher reads the first one's cache and never
// refetches what a cache holds, (b) a fetcher that cannot get the lock inside
// the bounded wait falls through to the NAMED queue-timeout outcome (read
// the cache, or record the waiver — the survey never blocks), and (c) every
// ok fetch records its source's history entry, feeding the anomaly floor by
// construction.
//
// The FETCH cache (this module) and the RENDER cache (the persisted briefs,
// later slices) are DIFFERENT referents — never conflated. The FETCH cache is
// content-keyed by the query URL under <sota-root>/fetch-cache/, written
// atomically (tmp+rename), fresh for FETCH_CACHE_TTL_MS:
//
//   FETCH_CACHE_TTL_MS = 6h — hours, not days: the fleet dedupes a burst of
//   on-demand casts inside one window, while the DAILY digest's cadence is
//   never starved (yesterday's payload is stale by the next morning).
//
// The recipe gotcha is MECHANICAL: http:// is refused outright with the named
// reason — the arXiv export API's http endpoint silently hangs; always
// https (the web-search recipe, verbatim, pinned in code not just prose).
//
// The sota root: $AMICO_SOTA_ROOT wins (hermetic tests); otherwise the
// FLEET-SHARED personal vault mount (the mounts resolver's personal mount —
// vault-aaron, synced across the fleet) + amicode/sota. A per-host path
// would serialize nothing; fleet-wide means the shared vault path.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { acquireQueueLock, releaseQueueLock, type QueueOpts } from "./sota_queue.js";
import { evaluateAnomalyFloor, readFetchHistory, recordFetchOutcome, type AnomalyFloorVerdict } from "./sota_history.js";
import { resolveMountStack, personalMount } from "./mounts.js";

/** The fetch cache's freshness window — see the header. */
export const FETCH_CACHE_TTL_MS = 6 * 60 * 60_000;

/** The shared production curl flags (B1, review fold on #828): `--fail`
 *  because WITHOUT it curl exits 0 on HTTP 403/404/429 and a server error
 *  launders as an empty success (status hardcoded 200, count 0 — stamps
 *  reset, last_success written, a fake zero in fetch history, the anomaly
 *  floor disarmed exactly when the fleet chronically fails); the bounded
 *  `--max-time 30` transport; a UA; and the `%{http_code}` write-out so the
 *  REAL status always rides the output — never a hardcoded 200. */
export function curlArgs(url: string, extraHeaders: string[] = []): string[] {
  const args = ["-sS", "--fail", "--max-time", "30", "-H", "user-agent: amicode-sota-review/0.1"];
  for (const h of extraHeaders) args.push("-H", h);
  args.push("-w", "\n%{http_code}", url);
  return args;
}

/** Split curl's stdout into body + the `-w %{http_code}` write-out. The
 *  write-out ALWAYS emits (even under --fail, where the body is suppressed),
 *  so this is the one place the real status is read. */
export function parseCurlOut(out: string): { body: string; status: number } {
  const idx = out.lastIndexOf("\n");
  if (idx === -1) return { body: "", status: Number.NaN };
  return { body: out.slice(0, idx), status: Number(out.slice(idx + 1).trim()) };
}

/** The transport seam — one query's worth of network. Injected in tests;
 *  the production body is subprocess curl (the S31 zero-dep doctrine,
 *  papers_digest.ts's fetchFeed). */
export type SotaFetch = (url: string) => Promise<
  | { ok: true; status: number; body: string; count: number }
  | { ok: false; status: number; error: string }
>;

export interface FetchThroughQueueOpts extends QueueOpts {
  root: string;
  fetchFn: SotaFetch;
  /** The history/anomaly source key (defaults to the URL's content key —
   *  recurring sources pass a stable explicit key). */
  sourceKey?: string;
  /** Skip the cache both ways (a forced refresh; still queued). */
  skipCache?: boolean;
}

export type FetchThroughQueueResult =
  | {
      via: "cache" | "fetched";
      ok: true;
      status: number;
      body: string;
      count: number;
      /** The anomaly-floor verdict for the returned payload — live fetches
       *  AND cache reads (A1: a cached empty scan renders the fill's verdict,
       *  never a false disarm). Undefined only when the floor could not be
       *  evaluated; `armed: false` is the honest unarmed state. */
      anomaly?: AnomalyFloorVerdict;
    }
  | { via: "queue-timeout"; ok: false; detail: string; waitedMs: number }
  | { via: "fetch-failed"; ok: false; status: number; error: string }
  | { via: "refused"; ok: false; reason: string };

/** The sota root — the FLEET-SHARED vault path. $AMICO_SOTA_ROOT wins (the
 *  hermetic escape); production is the personal vault mount + amicode/sota
 *  (the same mount the ledger-bridge contract writes under). */
export function sotaRoot(): string {
  const env = process.env.AMICO_SOTA_ROOT;
  if (env && env.trim() !== "") return env;
  const stack = resolveMountStack();
  const personal = personalMount(stack);
  const vaultPath = personal?.writable ? personal.path : join(homedir(), ".amico", "vaults");
  return join(vaultPath, "amicode", "sota");
}

/** The content key of a query URL — the cache file name AND the default
 *  history source key (one key space, two files). */
export function sourceKeyOf(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

export function cachePath(root: string, url: string): string {
  return join(root, "fetch-cache", `${sourceKeyOf(url)}.json`);
}

interface CacheEntry {
  url: string;
  fetched_at: string; // ISO-8601
  body: string;
  /** The payload's entry count, STORED AT FILL TIME (A1, review fold on
   *  #828): a cache read reports the real count — never a sentinel — and the
   *  anomaly floor is evaluated on the cache read, so an armed source served
   *  a cached empty payload renders the armed anomaly, never a false disarm. */
  count: number;
}

function readCache(root: string, url: string, opts: { nowMs: () => number; skipCache?: boolean }): CacheEntry | null {
  if (opts.skipCache) return null;
  const p = cachePath(root, url);
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<CacheEntry>;
    // count is REQUIRED (A1's shape): a legacy entry without it reads as a
    // miss and refetches — the 6h TTL makes the upgrade harmless.
    if (typeof j.body !== "string" || typeof j.fetched_at !== "string" || typeof j.count !== "number") return null;
    const age = opts.nowMs() - Date.parse(j.fetched_at);
    if (Number.isNaN(age) || age < 0 || age > FETCH_CACHE_TTL_MS) return null; // stale is not fresh
    return j as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(root: string, url: string, body: string, count: number, nowMs: () => number): void {
  mkdirSync(join(root, "fetch-cache"), { recursive: true });
  const p = cachePath(root, url);
  const tmp = `${p}.tmp-${process.pid}`;
  const entry: CacheEntry = { url, fetched_at: new Date(nowMs()).toISOString(), body, count };
  writeFileSync(tmp, JSON.stringify(entry) + "\n");
  renameSync(tmp, p);
}

/** The cache read's floor verdict (A1): evaluate against the fill's OWN prior
 *  history — entries from STRICTLY EARLIER fetch-days — reproducing the
 *  verdict the live fill computed. The fill already recorded its outcome; a
 *  cache read records nothing. */
function cachedAnomaly(root: string, sourceKey: string, cached: CacheEntry): AnomalyFloorVerdict {
  const fillDay = cached.fetched_at.slice(0, 10);
  const priorBeforeFill = readFetchHistory(root, sourceKey).filter((e) => e.date < fillDay);
  return evaluateAnomalyFloor(priorBeforeFill, { date: fillDay, count: cached.count });
}

/** The one-fetcher flow — cache → queue → re-check cache → fetch → cache +
 *  history. See the module header; the S6 property (a second fetcher reads
 *  the cache) is the under-lock re-check. */
export async function fetchThroughQueue(url: string, opts: FetchThroughQueueOpts): Promise<FetchThroughQueueResult> {
  // the recipe gotcha, mechanical: http:// hangs on the arXiv export API —
  // refuse it by name, before any lock or transport.
  if (/^http:\/\//i.test(url)) {
    return {
      via: "refused",
      ok: false,
      reason: "refused: http:// — the arXiv export API's http endpoint silently hangs; the sota fetch seam is https-only",
    };
  }
  const nowMs = opts.nowMs ?? Date.now;
  const sourceKey = opts.sourceKey ?? sourceKeyOf(url);

  const cached = readCache(opts.root, url, { nowMs, skipCache: opts.skipCache });
  if (cached !== null) {
    return { via: "cache", ok: true, status: 200, body: cached.body, count: cached.count, anomaly: cachedAnomaly(opts.root, sourceKey, cached) };
  }

  const lock = await acquireQueueLock(opts.root, opts);
  if (!lock.acquired) {
    return { via: "queue-timeout", ok: false, detail: lock.detail, waitedMs: lock.waitedMs };
  }
  try {
    // under the lock: RE-CHECK the cache — a fetcher that waited may find the
    // cache the lock-holder just wrote (the second-fetcher property).
    const underLock = readCache(opts.root, url, { nowMs, skipCache: opts.skipCache });
    if (underLock !== null) {
      return { via: "cache", ok: true, status: 200, body: underLock.body, count: underLock.count, anomaly: cachedAnomaly(opts.root, sourceKey, underLock) };
    }
    const res = await opts.fetchFn(url);
    if (!res.ok) {
      return { via: "fetch-failed", ok: false, status: res.status, error: res.error };
    }
    writeCache(opts.root, url, res.body, res.count, nowMs);
    // the anomaly floor: armed only after 7 prior fetch-days of THIS source's
    // history; the current fetch is not part of its own window.
    const prior = readFetchHistory(opts.root, sourceKey);
    const anomaly = evaluateAnomalyFloor(prior, { date: new Date(nowMs()).toISOString().slice(0, 10), count: res.count });
    recordFetchOutcome(opts.root, sourceKey, { date: new Date(nowMs()).toISOString().slice(0, 10), count: res.count });
    return { via: "fetched", ok: true, status: res.status, body: res.body, count: res.count, anomaly };
  } finally {
    releaseQueueLock(lock.lock);
  }
}
