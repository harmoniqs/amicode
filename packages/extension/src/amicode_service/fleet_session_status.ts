// FLEET SESSION STATUS (#1766): the fleet-wide, per-(owner, directory) session
// status read behind GET /amicode/fleet/session-status.
//
// Why it exists: a PEER session's busy/idle reaches this machine only through
// the live event fan-in, which does not replay on reconnect — and the engine
// keeps status PER DIRECTORY (a directory-less /session/status resolves to the
// engine's own cwd, a temp dir, and answers `{}` for every real session). So the
// app's reconnect re-seed names the sessions it displays (its pinned tabs) and
// this module resolves each one's OWNER and DIRECTORY from the live owner map,
// asks each owner for status IN THAT EXACT DIRECTORY, and returns ONE tri-state
// map: busy/retry (present in its own directory's answer), idle (its own
// directory's query succeeded and it is absent — a running turn lives in its
// directory's instance, so a busy session can never be absent there), or
// OMITTED (anything else — only omission preserves the client's current value).
//
// Two halves, each unit-testable with an injected fetch:
//   - RESOLUTION  (planFleetSessionStatus): ids + owner map → query plan + unresolved
//   - FAN-OUT     (fanOutFleetSessionStatus): plan → validated map + records
// The read never queries a directory that did not come from the owner map, and
// never throws: every failure is a NAMED record in a well-formed response.
import { serverAuthHeader } from "../server_auth";
import { peerAuthHeader, type FleetPeerSource, type ProjectionSourceOptions } from "./merged_projection";

// ── wire shapes (the issue's Data Contracts) ─────────────────────────────────

/** At most this many ids per read (after trim / drop-empty / de-dup). */
export const FLEET_STATUS_MAX_IDS = 64;
/** At most this many (owner, directory) queries per read. */
export const FLEET_STATUS_MAX_QUERIES = 16;

/** A validated session status, as passed through to the app. */
export type FleetSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number; action?: Record<string, unknown> };

export type UnresolvedReason = "unknown" | "no-directory" | "over-cap";

export interface UnresolvedEntry {
  id: string;
  reason: UnresolvedReason;
}

/** Owner-level reasons are the fleet projection's own source-absence vocabulary. */
export type OwnerAbsenceReason = "no-upstream" | "credential-missing" | "untrusted" | "identity-conflict";
export type DirectoryFailureReason = "unauthorized" | "fetch-failed" | "timeout" | "malformed";
export type FleetStatusReason = OwnerAbsenceReason | DirectoryFailureReason;

export interface DirectoryRecord {
  ok: boolean;
  reason?: FleetStatusReason;
  detail?: string;
  /** How many requested sessions resolved to this (owner, directory). */
  sessions: number;
}

export interface SourceRecord {
  present: boolean;
  reason?: OwnerAbsenceReason;
  detail?: string;
  directories: Record<string, DirectoryRecord>;
}

export interface FleetSessionStatusResponse {
  ok: true;
  statuses: Record<string, FleetSessionStatus>;
  sources: Record<string, SourceRecord>;
  unresolved: UnresolvedEntry[];
}

// ── resolution half ──────────────────────────────────────────────────────────

/** Split the comma-separated `ids` query value: trim, drop empty segments,
 *  de-duplicate (first occurrence wins — order is significant). */
export function parseStatusIds(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split(",")) {
    const id = segment.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The owner-map surface the resolution half reads. */
export interface StatusOwnerLookup {
  resolveOwner(sessionId: string): string | undefined;
  resolveDirectory(sessionId: string): string | undefined;
}

/** One (owner, directory) query, with the requested sessions it covers. */
export interface StatusQuery {
  owner: string;
  directory: string;
  sessionIds: string[];
}

export interface StatusPlan {
  queries: StatusQuery[];
  unresolved: UnresolvedEntry[];
}

/** RESOLUTION: group the requested ids by (owner, directory) from the owner map,
 *  in REQUEST order. At most `maxIds` ids are accepted (ids past it are
 *  `over-cap`); at most `maxQueries` distinct (owner, directory) queries are
 *  planned (a session whose query would exceed it is `over-cap`; one whose
 *  query is already planned still rides it). */
export function planFleetSessionStatus(
  ids: readonly string[],
  ownerMap: StatusOwnerLookup,
  caps: { maxIds?: number; maxQueries?: number } = {},
): StatusPlan {
  const maxIds = caps.maxIds ?? FLEET_STATUS_MAX_IDS;
  const maxQueries = caps.maxQueries ?? FLEET_STATUS_MAX_QUERIES;
  const queries: StatusQuery[] = [];
  const unresolved: UnresolvedEntry[] = [];
  const byKey = new Map<string, StatusQuery>();
  for (const [index, id] of ids.entries()) {
    if (index >= maxIds) {
      unresolved.push({ id, reason: "over-cap" });
      continue;
    }
    const owner = ownerMap.resolveOwner(id);
    if (!owner) {
      unresolved.push({ id, reason: "unknown" });
      continue;
    }
    const directory = ownerMap.resolveDirectory(id);
    if (!directory) {
      unresolved.push({ id, reason: "no-directory" });
      continue;
    }
    const k = JSON.stringify([owner, directory]);
    let q = byKey.get(k);
    if (!q) {
      if (queries.length >= maxQueries) {
        unresolved.push({ id, reason: "over-cap" });
        continue;
      }
      q = { owner, directory, sessionIds: [] };
      byKey.set(k, q);
      queries.push(q);
    }
    q.sessionIds.push(id);
  }
  return { queries, unresolved };
}

// ── source reach (the fleet projection's rules) ──────────────────────────────

/** How the read reaches each owner — the SAME inputs the fleet session
 *  projection takes: the local engine source + the serving peers (+ blocked). */
export interface FleetStatusSourceOptions {
  localMachineId: string;
  local: ProjectionSourceOptions;
  peers: FleetPeerSource[];
  blockedPeers?: Array<{ machineId: string; reason?: OwnerAbsenceReason; detail?: string }>;
}

type ResolvedSource =
  | { ok: true; origin: string; authHeader?: string }
  | { ok: false; reason: OwnerAbsenceReason; detail?: string };

/** Resolve one owner to its origin + credential, exactly as the projection
 *  reaches it: local = the engine origin with the engine password when armed,
 *  else the open loopback engine bare; a peer = its base origin with its OWN
 *  reader token. The hub credential is never involved. */
export function resolveStatusSource(owner: string, opts: FleetStatusSourceOptions): ResolvedSource {
  if (owner === opts.localMachineId) {
    const origin = opts.local.getUrl();
    if (!origin) return { ok: false, reason: "no-upstream" };
    // The open loopback engine is queried bare when no engine password is armed
    // (fetchSessions' allowUnauthenticated rule for the local source).
    return {
      ok: true,
      origin,
      ...(opts.local.password !== undefined ? { authHeader: serverAuthHeader(opts.local.password) } : {}),
    };
  }
  // #1481 (AC3): a blocked identity is NAMED, never contacted.
  const blocked = (opts.blockedPeers ?? []).find((b) => b.machineId === owner);
  if (blocked) {
    return {
      ok: false,
      reason: blocked.reason ?? "identity-conflict",
      ...(blocked.detail !== undefined ? { detail: blocked.detail } : {}),
    };
  }
  const peer = opts.peers.find((p) => p.machineId === owner);
  // An owner that is not a serving peer has no transport (unreachable).
  if (!peer) return { ok: false, reason: "no-upstream" };
  // #1481 (AC1): TRUST gates the read, BEFORE reachability — an untrusted peer
  // is never contacted.
  if (peer.trusted === false) return { ok: false, reason: "untrusted" };
  const origin = peer.getUrl();
  if (!origin) return { ok: false, reason: "no-upstream" };
  // No credential ⇒ never fire an unauthenticated cross-machine request.
  if (peer.token === undefined || peer.token === "") return { ok: false, reason: "credential-missing" };
  return { ok: true, origin, authHeader: peerAuthHeader(peer.token) };
}

// ── status validation (the engine's own SessionStatus schema) ────────────────

const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate ONE owner-answer entry against the engine's SessionStatus union:
 *  `{type:"idle"}`, `{type:"busy"}`, or `{type:"retry", attempt:int≥0,
 *  message:string, next:int≥0, action?:object}`. Like the engine's Effect
 *  Struct, excess keys are ignored — and only the documented fields pass
 *  through. Undefined ⇒ an unrecognized shape. */
export function validateSessionStatus(entry: unknown): FleetSessionStatus | undefined {
  if (!isPlainObject(entry)) return undefined;
  switch (entry.type) {
    case "idle":
      return { type: "idle" };
    case "busy":
      return { type: "busy" };
    case "retry": {
      const { attempt, message, next, action } = entry;
      if (!isNonNegativeInt(attempt) || typeof message !== "string" || !isNonNegativeInt(next)) return undefined;
      if (action !== undefined && !isPlainObject(action)) return undefined;
      return { type: "retry", attempt, message, next, ...(action !== undefined ? { action } : {}) };
    }
    default:
      return undefined;
  }
}

// ── fan-out half ─────────────────────────────────────────────────────────────

/** The overall deadline for one read's fan-out. */
export const FLEET_STATUS_DEADLINE_MS = 3000;
/** Each (owner, directory) query's own timeout (inside the deadline). */
export const FLEET_STATUS_QUERY_TIMEOUT_MS = 2500;

export interface FanOutOptions {
  sources: FleetStatusSourceOptions;
  fetchImpl?: typeof fetch;
  /** Overall deadline (default FLEET_STATUS_DEADLINE_MS). */
  deadlineMs?: number;
  /** Per-query timeout (default FLEET_STATUS_QUERY_TIMEOUT_MS). */
  queryTimeoutMs?: number;
}

type QueryOutcome =
  | { ok: true; answer: Map<string, FleetSessionStatus> }
  | { ok: false; reason: DirectoryFailureReason; detail?: string };

const errorDetail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function queryDirectory(
  source: { origin: string; authHeader?: string },
  directory: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<QueryOutcome> {
  // The directory is passed byte-for-byte as the owner map carries it,
  // URL-encoded as ONE query value — never normalized.
  const url = `${source.origin.replace(/\/+$/, "")}/session/status?directory=${encodeURIComponent(directory)}`;
  const headers: Record<string, string> = source.authHeader ? { Authorization: source.authHeader } : {};
  try {
    const res = await fetchImpl(url, { headers, signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized", detail: `HTTP ${res.status}` };
    if (res.status !== 200) return { ok: false, reason: "fetch-failed", detail: `HTTP ${res.status}` };
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch (e) {
      if (signal.aborted) return { ok: false, reason: "timeout", detail: "query timeout" };
      return { ok: false, reason: "fetch-failed", detail: `HTTP 200 with a non-JSON body (${errorDetail(e)})` };
    }
    // 200 + an OBJECT body is coverage; every entry must be a recognized shape,
    // or the whole (owner, directory) is malformed (its sessions omitted).
    if (!isPlainObject(body)) return { ok: false, reason: "malformed", detail: "status answer is not an object" };
    // A Map, never a plain object: a requested id must not resolve an
    // inherited key (`constructor`, `__proto__`) to a phantom status.
    const answer = new Map<string, FleetSessionStatus>();
    for (const [id, entry] of Object.entries(body)) {
      const status = validateSessionStatus(entry);
      if (!status) return { ok: false, reason: "malformed", detail: `unrecognized status entry for ${id}` };
      answer.set(id, status);
    }
    return { ok: true, answer };
  } catch (e) {
    if (signal.aborted) return { ok: false, reason: "timeout", detail: "query timeout" };
    return { ok: false, reason: "fetch-failed", detail: errorDetail(e) };
  }
}

/** Resolve an owner's source, never throwing (a throwing getter is no-upstream). */
function safeResolveSource(owner: string, opts: FleetStatusSourceOptions): ResolvedSource {
  try {
    return resolveStatusSource(owner, opts);
  } catch (e) {
    return { ok: false, reason: "no-upstream", detail: errorDetail(e) };
  }
}

/** FAN-OUT: run the plan's queries CONCURRENTLY, each with its own timeout,
 *  under one overall deadline, and assemble the tri-state map. A query still
 *  pending at the deadline is `timeout` (its sessions omitted); everything that
 *  did arrive is returned. Never throws. */
export async function fanOutFleetSessionStatus(plan: StatusPlan, opts: FanOutOptions): Promise<FleetSessionStatusResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const deadlineMs = opts.deadlineMs ?? FLEET_STATUS_DEADLINE_MS;
  const queryTimeoutMs = opts.queryTimeoutMs ?? FLEET_STATUS_QUERY_TIMEOUT_MS;
  const statuses = new Map<string, FleetSessionStatus>();
  const sources: Record<string, SourceRecord> = {};
  // Resolve each owner ONCE; an unusable owner lists its directories as not
  // attempted, each carrying the owner's reason.
  const resolved = new Map<string, ResolvedSource>();
  for (const q of plan.queries) {
    if (resolved.has(q.owner)) continue;
    const source = safeResolveSource(q.owner, opts.sources);
    resolved.set(q.owner, source);
    sources[q.owner] = source.ok
      ? { present: true, directories: {} }
      : {
          present: false,
          reason: source.reason,
          ...(source.detail !== undefined ? { detail: source.detail } : {}),
          directories: {},
        };
  }

  const record = (q: StatusQuery, outcome: QueryOutcome): void => {
    const directories = sources[q.owner].directories;
    if (!outcome.ok) {
      directories[q.directory] = {
        ok: false,
        reason: outcome.reason,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        sessions: q.sessionIds.length,
      };
      return;
    }
    directories[q.directory] = { ok: true, sessions: q.sessionIds.length };
    // idle by ABSENCE: the session's own directory answered and it is not busy.
    for (const id of q.sessionIds) statuses.set(id, outcome.answer.get(id) ?? { type: "idle" });
  };

  // The overall deadline: one timer for the whole read; at expiry every
  // unsettled query is recorded `timeout` and aborted.
  const controllers: AbortController[] = [];
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  try {
    await Promise.all(
      plan.queries.map(async (q) => {
        const source = resolved.get(q.owner)!;
        if (!source.ok) {
          // not attempted: the directory carries the owner's own reason
          sources[q.owner].directories[q.directory] = { ok: false, reason: source.reason, sessions: q.sessionIds.length };
          return;
        }
        const controller = new AbortController();
        controllers.push(controller);
        const perQuery = setTimeout(() => controller.abort(), queryTimeoutMs);
        try {
          const outcome = await Promise.race([
            queryDirectory(source, q.directory, fetchImpl, controller.signal),
            deadline.then((): QueryOutcome => ({ ok: false, reason: "timeout", detail: "overall deadline" })),
          ]);
          record(q, outcome);
        } finally {
          clearTimeout(perQuery);
        }
      }),
    );
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    for (const c of controllers) if (!c.signal.aborted) c.abort();
  }
  // Object.fromEntries defines OWN properties (safe for any id string).
  return { ok: true, statuses: Object.fromEntries(statuses), sources, unresolved: [...plan.unresolved] };
}

// ── the composed read ────────────────────────────────────────────────────────

export interface ReadFleetSessionStatusOptions extends FanOutOptions {
  ownerMap: StatusOwnerLookup;
}

/** An owner-map lookup that never throws (a throwing lookup is `unknown`). */
function safeLookup(ownerMap: StatusOwnerLookup): StatusOwnerLookup {
  return {
    resolveOwner: (id) => {
      try {
        return ownerMap.resolveOwner(id);
      } catch {
        return undefined;
      }
    },
    resolveDirectory: (id) => {
      try {
        return ownerMap.resolveDirectory(id);
      } catch {
        return undefined;
      }
    },
  };
}

/** The whole read: parse the raw `ids` value, resolve, fan out. An empty
 *  request is an empty map with NO upstream call. Never throws. */
export async function readFleetSessionStatus(
  rawIds: string | null | undefined,
  opts: ReadFleetSessionStatusOptions,
): Promise<FleetSessionStatusResponse> {
  const ids = parseStatusIds(rawIds);
  if (ids.length === 0) return { ok: true, statuses: {}, sources: {}, unresolved: [] };
  const plan = planFleetSessionStatus(ids, safeLookup(opts.ownerMap));
  try {
    return await fanOutFleetSessionStatus(plan, opts);
  } catch {
    // Defensive: the fan-out is built not to throw; should it, the honest
    // answer is "nothing covered" — never an error dump, never a fake idle.
    return { ok: true, statuses: {}, sources: {}, unresolved: [...plan.unresolved] };
  }
}
