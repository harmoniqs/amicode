// MERGED PROJECTION (amicissimo#391 — the local-shell data plane, D2): the
// fleet mode's read path. Session lists compose from BOTH stores — the hub
// (the fleet session's store of record, routed through the tunneled proxy)
// AND the client's local engine (the local engine remains a data source) —
// into ONE merged, PROVENANCE-TAGGED projection.
//
// The founding pain (#779) stays dead in BOTH directions: hub sessions are
// visible in the merged list, and local sessions never vanish because
// routing moved. The hub-only read path that would rebirth the store split
// on the standalone→fleet crossing was the reviewed-and-REJECTED design
// (sub-spec "Approaches considered") — this module is the merged one.
//
// Currency (D2): the token is DERIVED OVER WHAT IS ACTUALLY FETCHED —
// count/max/sum + the source's server version stamp per contributing
// source — and TAGGED with its data sources, so a token derived over one
// upstream is never compared against another. A source that did not fetch
// contributes NOTHING (named absence, never a cached superset).
//
// Conflicts (a session id in both stores): the hub is the store of record
// for fleet sessions — hub wins, and the provenance tag says so.
import { createHash } from "node:crypto";
import { HubCredentialRead, hubUpstreamAuthHeader } from "./hub_credential";
import { serverAuthHeader } from "../server_auth";

export type SourceTag = "local" | "hub";
export type UpstreamMode = "engine" | "fleet";

export type SourceAbsenceReason = "credential-missing" | "no-upstream" | "fetch-failed" | "unauthorized";

/** One source's fetch record: the NAMED outcome plus, when fetched, the
 *  currency aggregates derived over exactly what came back. */
export interface SourceFetchRecord {
  source: SourceTag;
  present: boolean;
  reason?: SourceAbsenceReason;
  detail?: string;
  /** Currency over the fetched entries (absent when the source did not fetch). */
  count?: number;
  /** Max `time.updated` epoch ms across fetched entries; null when none carry one. */
  max?: number | null;
  /** Sum of `time.updated` epoch ms (a reorder guard on top of count+max). */
  sum?: number;
  /** The source's server version stamp (GET /global/health → version). */
  version?: string | null;
}

export interface MergedProjection {
  ok: true;
  mode: "fleet";
  /** The merged session list; each entry carries `amicode_provenance`. */
  sessions: Array<Record<string, unknown> & { amicode_provenance?: SourceTag }>;
  sources: Record<SourceTag, SourceFetchRecord>;
  currency: { token: string; sources: SourceTag[]; derived_over: "fetched" };
}

export interface ProjectionSourceOptions {
  /** The origin to fetch (late-bound like every upstream in this service). */
  getUrl(): string | undefined;
  /** The engine mint's password (the local source). */
  password?: string;
  /** The hub mint's NAMED read (the hub source). */
  credential?: HubCredentialRead;
}

export interface BuildProjectionOptions {
  local: ProjectionSourceOptions;
  hub: ProjectionSourceOptions;
  fetchImpl?: typeof fetch;
  /** The fetch guard (transport hygiene — NOT D6's degraded detector, which
   *  is Slice B's outcome-stream machinery). Default 10s. */
  timeoutMs?: number;
}

/** Extract the updated-at epoch ms an entry carries, defensively — the
 *  projection must never die on one weird session. */
export function sessionUpdatedAt(entry: Record<string, unknown>): number | null {
  const time = entry["time"];
  if (typeof time === "object" && time !== null) {
    const updated = (time as Record<string, unknown>)["updated"];
    if (typeof updated === "number" && Number.isFinite(updated)) return updated;
  }
  for (const key of ["updatedAt", "updated_at", "time_updated"]) {
    const v = entry[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function entryId(entry: Record<string, unknown>): string | undefined {
  const id = entry["id"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

async function fetchSessions(
  tag: SourceTag,
  opts: ProjectionSourceOptions,
  authHeader: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ record: SourceFetchRecord; entries: Record<string, unknown>[] }> {
  const base: SourceFetchRecord = { source: tag, present: false };
  const origin = opts.getUrl();
  if (!origin) return { record: { ...base, reason: "no-upstream" }, entries: [] };
  if (!authHeader) {
    return {
      record: {
        ...base,
        reason: tag === "hub" ? "credential-missing" : "credential-missing",
        detail: tag === "hub" ? "hub credential absent/malformed/incomplete" : "engine mint not armed",
      },
      entries: [],
    };
  }
  try {
    const res = await fetchImpl(`${origin.replace(/\/+$/, "")}/session`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { record: { ...base, reason: "unauthorized" }, entries: [] };
    if (!res.ok) {
      return { record: { ...base, reason: "fetch-failed", detail: `HTTP ${res.status}` }, entries: [] };
    }
    const parsed: unknown = await res.json();
    if (!Array.isArray(parsed)) {
      return { record: { ...base, reason: "fetch-failed", detail: "session list is not an array" }, entries: [] };
    }
    const entries = parsed.filter(
      (e): e is Record<string, unknown> => typeof e === "object" && e !== null && !Array.isArray(e),
    );
    // currency over what is actually fetched — count/max/sum
    let max: number | null = null;
    let sum = 0;
    for (const e of entries) {
      const updated = sessionUpdatedAt(e);
      if (updated !== null) {
        max = max === null ? updated : Math.max(max, updated);
        sum += updated;
      }
    }
    // the source's version stamp (the lifecycle D2 "serverSDK.version()"
    // equivalent for the transport side: /global/health → version)
    let version: string | null = null;
    try {
      const health = await fetchImpl(`${origin.replace(/\/+$/, "")}/global/health`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (health.ok) {
        const body = (await health.json()) as { version?: unknown };
        if (typeof body.version === "string") version = body.version;
      }
    } catch {
      /* the stamp fails open to null — the record stays honest via the field */
    }
    const record: SourceFetchRecord = { source: tag, present: true, count: entries.length, max, sum, version };
    return { record, entries };
  } catch (e) {
    return {
      record: { ...base, reason: "fetch-failed", detail: e instanceof Error ? e.message : String(e) },
      entries: [],
    };
  }
}

/** Merge both stores into ONE provenance-tagged list. The hub wins conflicts
 *  (the store of record for fleet sessions); locals stay tagged local. */
export function mergeSessions(
  localEntries: Record<string, unknown>[],
  hubEntries: Record<string, unknown>[],
): Array<Record<string, unknown> & { amicode_provenance?: SourceTag }> {
  const out: Array<Record<string, unknown> & { amicode_provenance?: SourceTag }> = [];
  const seen = new Map<string, number>();
  for (const e of hubEntries) {
    const id = entryId(e);
    const tagged = { ...e, amicode_provenance: "hub" as const };
    if (id !== undefined) seen.set(id, out.length);
    out.push(tagged);
  }
  for (const e of localEntries) {
    const id = entryId(e);
    if (id !== undefined && seen.has(id)) {
      // the hub is the store of record — the hub's entry already stands;
      // the local copy does not shadow it (it stays in its own store)
      continue;
    }
    const tagged = { ...e, amicode_provenance: "local" as const };
    if (id !== undefined) seen.set(id, out.length);
    out.push(tagged);
  }
  return out;
}

/** D2's currency derivation: count/max/sum + version per CONTRIBUTING
 *  source, tagged with the source list — a token derived over one upstream
 *  is never compared against another because the sources are IN the hash. */
export function deriveCurrency(records: SourceFetchRecord[]): {
  token: string;
  sources: SourceTag[];
} {
  const contributing = records
    .filter((r) => r.present)
    .sort((a, b) => a.source.localeCompare(b.source));
  const sources = contributing.map((r) => r.source);
  const canonical = JSON.stringify({
    sources,
    bySource: Object.fromEntries(
      contributing.map((r) => [r.source, { count: r.count, max: r.max, sum: r.sum, version: r.version }]),
    ),
  });
  const token = `cur-${createHash("sha256").update(canonical).digest("hex")}`;
  return { token, sources };
}

/** Build the merged projection (D2). Never throws: every source failure is
 *  a NAMED record inside an otherwise-valid projection — the read path
 *  degrades by naming, not by vanishing. */
export async function buildMergedProjection(opts: BuildProjectionOptions): Promise<MergedProjection> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const hubCred = opts.hub.credential;
  const hubAuth =
    hubCred !== undefined && hubCred.ok ? hubUpstreamAuthHeader(hubCred.credential.token) : undefined;
  const localAuth = opts.local.password !== undefined ? serverAuthHeader(opts.local.password) : undefined;

  const [local, hub] = await Promise.all([
    fetchSessions("local", opts.local, localAuth, fetchImpl, timeoutMs),
    fetchSessions("hub", opts.hub, hubAuth, fetchImpl, timeoutMs),
  ]);

  const sources: Record<SourceTag, SourceFetchRecord> = { local: local.record, hub: hub.record };
  const sessions = mergeSessions(local.entries, hub.entries);
  const currency = deriveCurrency([local.record, hub.record]);
  return { ok: true, mode: "fleet", sessions, sources, currency: { ...currency, derived_over: "fetched" } };
}
