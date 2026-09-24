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

export type SourceTag = string;
export type UpstreamMode = "engine" | "fleet";

// ── N-peer fleet-wide projection (#1439) ─────────────────────────────────────

/** The owner tag overlaid on each session in a fleet-wide projection —
 *  an OVERLAY, not a field on Session.Info (ADR 0031 §D3). */
export interface SessionOwnerTag {
  owner_machine_id: string;
  owner_name: string;
  device_type?: string;
  directory?: string;
  is_local: boolean;
}

/** A remote peer source for the fleet-wide fan-out. */
export interface FleetPeerSource {
  machineId: string;
  getUrl(): string | undefined;
  /** The peer token (from the reader peer-token store). */
  token?: string;
  /** #1481 (AC1): whether THIS machine holds a valid Observe grant for the peer
   *  — TRUST, not reachability, gates observation. `false` means untrusted: the
   *  peer contributes NO session metadata and is recorded as `untrusted` (never
   *  fetched). Omitted/`true` = trusted (the #1455 back-compat default, so every
   *  existing caller behaves exactly as before). */
  trusted?: boolean;
}

/** Roster entry for name/device_type enrichment. */
export interface RosterEntry {
  name: string;
  device_type?: string;
}

/** Options for the N-peer fleet-wide projection. */
export interface FleetProjectionOptions {
  /** This machine's stable id. */
  localMachineId: string;
  /** The local engine source. */
  local: ProjectionSourceOptions;
  /** Remote peers to fan out to (keyed by machineId). */
  peers: FleetPeerSource[];
  /** #1481 (AC3): peers EXCLUDED from selection by a blocking identity state
   *  (alias-conflict / key-changed). They are NOT fetched, but each is recorded
   *  as a NAMED source (default reason `identity-conflict`) so a conflicted peer
   *  never silently vanishes from the projection — the central AC3 invariant. */
  blockedPeers?: Array<{ machineId: string; reason?: SourceAbsenceReason; detail?: string }>;
  /** Roster lookup for owner_name/device_type enrichment. */
  rosterLookup: (machineId: string) => RosterEntry | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The fleet-wide projection result — N sources, machine-keyed. */
export interface FleetProjection {
  ok: true;
  mode: "fleet";
  /** Each entry carries `amicode_owner` (the owner tag overlay). */
  sessions: Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }>;
  /** Keyed by machine_id (string), not the old "local"|"hub" pair. */
  sources: Record<string, SourceFetchRecord>;
  currency: { token: string; sources: string[]; derived_over: "fetched" };
}

export type SourceAbsenceReason =
  | "credential-missing"
  | "no-upstream"
  | "fetch-failed"
  | "unauthorized"
  // #1481 (AC1): the peer is reachable but this machine holds NO Observe grant
  // for it — trust, not reachability, gates observation. A DISTINCT state from
  // `no-upstream` (a trusted peer whose URL is down); an untrusted peer is never
  // fetched, so no session metadata can leak.
  | "untrusted"
  // #1481 (AC3): a blocking identity reconciliation state (alias-conflict /
  // key-changed) — the peer is NAMED (never silently excluded from the
  // projection), but is not selected for observation until re-admitted.
  | "identity-conflict";

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

// ── peer auth header (#1439) ─────────────────────────────────────────────────

/** Auth header for a peer-to-peer request (same Basic scheme as the engine/hub). */
export function peerAuthHeader(token: string): string {
  return serverAuthHeader(token);
}

// ── N-peer fleet-wide projection (#1439) ─────────────────────────────────────

/** Tag each session entry with its owner machine's identity, joining the
 *  roster for name/device_type. */
function tagSessionsWithOwner(
  entries: Record<string, unknown>[],
  machineId: string,
  isLocal: boolean,
  rosterLookup: (id: string) => RosterEntry | undefined,
): Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }> {
  const roster = rosterLookup(machineId);
  return entries.map((e) => ({
    ...e,
    amicode_provenance: machineId,
    amicode_owner: {
      owner_machine_id: machineId,
      owner_name: roster?.name ?? machineId,
      ...(roster?.device_type !== undefined ? { device_type: roster.device_type } : {}),
      ...(typeof e.directory === "string" ? { directory: e.directory } : {}),
      is_local: isLocal,
    },
  }));
}

/** Merge N sources into one deduplicated list. Later sources (by array order)
 *  win on conflict (same session id in multiple stores). */
function mergeNSources(
  taggedSources: Array<{ machineId: string; entries: Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }> }>,
): Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }> {
  const out: Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }> = [];
  const seen = new Map<string, number>();
  for (const { entries } of taggedSources) {
    for (const e of entries) {
      const id = entryId(e);
      if (id !== undefined && seen.has(id)) {
        // later source wins — replace
        out[seen.get(id)!] = e;
      } else {
        if (id !== undefined) seen.set(id, out.length);
        out.push(e);
      }
    }
  }
  return out;
}

/** Build the fleet-wide projection (N-peer, machine-keyed fan-out, #1439).
 *  Never throws: every peer failure is a NAMED record inside an otherwise-valid
 *  projection — the read path degrades by naming, not by vanishing. */
export async function buildFleetProjection(opts: FleetProjectionOptions): Promise<FleetProjection> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const localAuth = opts.local.password !== undefined ? serverAuthHeader(opts.local.password) : undefined;

  // Fan out: local + all peers in parallel
  const localPromise = fetchSessions(opts.localMachineId, opts.local, localAuth, fetchImpl, timeoutMs);
  const peerPromises = opts.peers.map((peer) => {
    // #1481 (AC1): TRUST gates Observe. An untrusted peer (no Observe grant) is
    // never contacted — it resolves to a NAMED `untrusted` record with zero
    // entries, so no session metadata can leak. Trust is checked BEFORE the
    // fetch, upstream of the URL/token, so reachability is irrelevant here.
    if (peer.trusted === false) {
      return Promise.resolve({
        record: { source: peer.machineId, present: false, reason: "untrusted" as const } satisfies SourceFetchRecord,
        entries: [] as Record<string, unknown>[],
      });
    }
    const auth = peer.token !== undefined ? peerAuthHeader(peer.token) : undefined;
    return fetchSessions(peer.machineId, { getUrl: peer.getUrl }, auth, fetchImpl, timeoutMs);
  });

  const [localResult, ...peerResults] = await Promise.all([localPromise, ...peerPromises]);

  // Build the sources record keyed by machine_id
  const sources: Record<string, SourceFetchRecord> = {};
  sources[opts.localMachineId] = localResult.record;
  for (let i = 0; i < opts.peers.length; i++) {
    sources[opts.peers[i].machineId] = peerResults[i].record;
  }
  // #1481 (AC3): blocked-identity peers are NAMED (never fetched, never
  // silently dropped) so a conflicted peer stays visible as a source state
  // rather than vanishing from the projection.
  for (const blocked of opts.blockedPeers ?? []) {
    sources[blocked.machineId] = {
      source: blocked.machineId,
      present: false,
      reason: blocked.reason ?? "identity-conflict",
      ...(blocked.detail !== undefined ? { detail: blocked.detail } : {}),
    };
  }

  // Tag each source's sessions with owner info (roster join)
  const taggedSources: Array<{ machineId: string; entries: Array<Record<string, unknown> & { amicode_owner?: SessionOwnerTag }> }> = [];
  taggedSources.push({
    machineId: opts.localMachineId,
    entries: tagSessionsWithOwner(localResult.entries, opts.localMachineId, true, opts.rosterLookup),
  });
  for (let i = 0; i < opts.peers.length; i++) {
    taggedSources.push({
      machineId: opts.peers[i].machineId,
      entries: tagSessionsWithOwner(peerResults[i].entries, opts.peers[i].machineId, false, opts.rosterLookup),
    });
  }

  // Merge all sources
  const sessions = mergeNSources(taggedSources);

  // Currency derives over what is actually fetched
  const allRecords = [localResult.record, ...peerResults.map((r) => r.record)];
  const currency = deriveCurrency(allRecords);

  return { ok: true, mode: "fleet", sessions, sources, currency: { ...currency, derived_over: "fetched" } };
}
