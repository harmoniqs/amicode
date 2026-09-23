// #1481 (Binding Amendment) — the trusted-Observe RETENTION layer + the
// read-only transcript view.
//
// Central invariant: "missing projection data may NEVER render a session as
// local." Every row the UI sees carries an `amicode_owner` tag and a NAMED
// `amicode_availability` state. Source LOSS retains last-known remote sessions
// as "unavailable". Trust REVOCATION strips sensitive metadata, leaving a
// non-sensitive tombstone ("revoked"). A present source passes through as
// "present".
//
// This WRAPS #1455's FleetProjection (AC5 — never replaces): it observes a
// sequence of projections and reconciles the output.
import type { FleetProjection, SourceFetchRecord, SessionOwnerTag, SourceAbsenceReason } from "./merged_projection";
import { peerAuthHeader } from "./merged_projection";

// ── types ────────────────────────────────────────────────────────────────────

/** The named availability states a session row can carry. */
export type ObserveAvailability = "present" | "unavailable" | "revoked";

/** A session row enriched with the Observe availability state. Every row
 *  carries `amicode_owner` (the never-local invariant) and
 *  `amicode_availability` (the named state the UI renders). */
export interface ObserveSessionRow {
  id: string;
  amicode_owner: SessionOwnerTag;
  amicode_availability: ObserveAvailability;
  /** All other session fields ride through as unknown properties. */
  [key: string]: unknown;
}

// ── retention logic ──────────────────────────────────────────────────────────

/** The reasons that produce a TOMBSTONE (sensitive data stripped, non-sensitive
 *  owner provenance kept). These are trust-breaking — the peer can no longer
 *  be trusted with its metadata. */
const TRUST_BREAKING_REASONS: ReadonlySet<SourceAbsenceReason> = new Set([
  "untrusted",
  "unauthorized",
  "identity-conflict",
]);

/** The Observe retention layer: reconciles a stream of FleetProjection
 *  snapshots into a stable, never-local-masquerading session list. */
export class ObserveRetention {
  /** Last-known sessions per remote source, keyed by owner_machine_id. */
  private retained = new Map<string, ObserveSessionRow[]>();

  /** Reconcile a new projection snapshot into the stable row set.
   *
   *  - Present sources: sessions pass through with availability "present".
   *  - Absent sources (transport failure, no-upstream): RETAINED as
   *    "unavailable" from the last-known snapshot.
   *  - Trust-breaking absences (untrusted, unauthorized, identity-conflict):
   *    RETAINED as "revoked" tombstones (sensitive metadata stripped).
   *  - Local sessions: NEVER retained (they are genuinely the local engine's
   *    sessions; if the local source fails, they are gone).
   */
  reconcile(projection: FleetProjection): ObserveSessionRow[] {
    const rows: ObserveSessionRow[] = [];
    const presentSources = new Set<string>();

    // Index the projection's sessions by their owner machine_id.
    const sessionsBySource = new Map<string, ObserveSessionRow[]>();
    for (const entry of projection.sessions) {
      const owner = (entry as { amicode_owner?: SessionOwnerTag }).amicode_owner;
      if (!owner) continue;
      const machineId = owner.owner_machine_id;
      const row: ObserveSessionRow = {
        ...(entry as Record<string, unknown>),
        id: String((entry as Record<string, unknown>).id ?? ""),
        amicode_owner: owner,
        amicode_availability: "present",
      };
      if (!sessionsBySource.has(machineId)) sessionsBySource.set(machineId, []);
      sessionsBySource.get(machineId)!.push(row);
    }

    // Walk every source in the projection.
    for (const [sourceId, record] of Object.entries(projection.sources)) {
      if (record.present) {
        // Source is present: pass through with "present" availability.
        presentSources.add(sourceId);
        const sessions = sessionsBySource.get(sourceId) ?? [];
        for (const s of sessions) rows.push(s);
        // Update the retained snapshot for this source (remote only).
        if (sessions.length > 0 && !sessions[0].amicode_owner.is_local) {
          this.retained.set(sourceId, sessions);
        }
      } else {
        // Source is absent. Check if we have retained sessions for it.
        const lastKnown = this.retained.get(sourceId);
        if (lastKnown && lastKnown.length > 0) {
          const isTrustBreaking = record.reason !== undefined && TRUST_BREAKING_REASONS.has(record.reason);
          if (isTrustBreaking) {
            // Trust-breaking: produce tombstones (strip sensitive metadata).
            for (const s of lastKnown) {
              rows.push(tombstone(s));
            }
            // Clear retained data for this source (tombstone is final until re-trust).
            this.retained.set(sourceId, lastKnown.map(tombstone));
          } else {
            // Transport failure / no-upstream: retain with "unavailable".
            for (const s of lastKnown) {
              rows.push({ ...s, amicode_availability: "unavailable" });
            }
          }
        }
      }
    }

    return rows;
  }
}

/** Produce a tombstone from a session row: keep the id + owner provenance,
 *  strip all sensitive metadata (title, directory, and any other session-
 *  specific fields). The owner_machine_id, owner_name, and is_local are
 *  non-sensitive (they identify WHICH machine, not WHAT it was doing). */
function tombstone(row: ObserveSessionRow): ObserveSessionRow {
  return {
    id: row.id,
    amicode_owner: {
      owner_machine_id: row.amicode_owner.owner_machine_id,
      owner_name: row.amicode_owner.owner_name,
      is_local: row.amicode_owner.is_local,
      // device_type is non-sensitive (it's machine metadata, not session content)
      ...(row.amicode_owner.device_type !== undefined ? { device_type: row.amicode_owner.device_type } : {}),
      // directory IS sensitive (it reveals the workspace path) — stripped
    },
    amicode_availability: "revoked",
    amicode_provenance: row.amicode_owner.owner_machine_id,
  };
}

// ── read-only transcript fetch ───────────────────────────────────────────────

export interface TranscriptMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export type TranscriptResult =
  | { ok: true; messages: TranscriptMessage[] }
  | { ok: false; reason: "transport-error" | "unauthorized" | "not-found" | "unknown" };

export interface FetchTranscriptOptions {
  baseUrl: string;
  sessionId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Fetch a remote session's transcript via GET (read-only — Observe performs
 *  no remote mutation). Returns a named result, never throws. */
export async function fetchRemoteTranscript(opts: FetchTranscriptOptions): Promise<TranscriptResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/session/${encodeURIComponent(opts.sessionId)}`;
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: peerAuthHeader(opts.token) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (res.status === 404) {
      return { ok: false, reason: "not-found" };
    }
    if (!res.ok) {
      return { ok: false, reason: "unknown" };
    }
    const body = await res.json() as { messages?: unknown[] };
    const messages: TranscriptMessage[] = Array.isArray(body.messages)
      ? body.messages.filter(
          (m): m is TranscriptMessage =>
            typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).role === "string",
        )
      : [];
    return { ok: true, messages };
  } catch {
    return { ok: false, reason: "transport-error" };
  }
}
