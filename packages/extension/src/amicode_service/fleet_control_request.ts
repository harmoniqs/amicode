// SHARED-PEER CONTROL REQUEST STORE (#1545, ADR 0034 D3) — the request→approve
// handshake for a shared peer that cannot use the self-owned fast-path. A
// shared peer POSTs a control request routed to the target's lifecycle-admin
// authority holder; the authority holder approves (minting a control grant via
// issueLifecycleGrant) or denies (fail-closed — no grant, no control).
//
// This module owns the pending-request store (file-based, keyed, state machine:
// pending → approved|denied) and the submit/approve/deny operations. It is
// consumed by the server routes (POST /amicode/fleet/control-request,
// /control-approve, /control-deny) and the Fleet Manager's pending-requests
// view (#1544).
//
// The store is DISTINCT from the lifecycle grant store — a request is the
// PRECURSOR to a grant, not a grant itself. On approval, the request transitions
// to "approved" AND issueLifecycleGrant mints the actual control grant.
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeyedCollection, upsertKeyedEntry } from "./keyed_store";
import {
  issueLifecycleGrant,
  findControlGrantByTarget,
  type LifecycleGrant,
  type LifecycleGrantDeps,
} from "./fleet_control_lifecycle";

// ── Store constants ──────────────────────────────────────────────────────────

export const CONTROL_REQUEST_STORE_VERSION = 1;
const REQUESTS_COLLECTION = "control_requests";

// ── Types ────────────────────────────────────────────────────────────────────

export type ControlRequestStatus = "pending" | "approved" | "denied";

/** A control request: a shared peer asking for control over a target. */
export interface ControlRequestRecord {
  requesterMachineId: string;
  requesterIdentityKey: string;
  targetMachineId: string;
  targetIdentityKey: string;
  status: ControlRequestStatus;
  requestedAt: string;
  resolvedAt?: string;
}

/** The submit inputs (what the requester sends). */
export interface ControlRequest {
  requesterMachineId: string;
  requesterIdentityKey: string;
  targetMachineId: string;
  targetIdentityKey: string;
}

/** Dependencies (injectable for testing). */
export interface ControlRequestDeps {
  /** Override the store file. Default:
   *  $AMICO_FLEET_CONTROL_REQUEST_FILE → ~/.amico/fleet-control-requests.json. */
  requestStoreFile?: string;
  /** The lifecycle grant deps (the approval path mints a grant). */
  grantDeps?: LifecycleGrantDeps;
  /** ISO clock. Default: now. */
  now?: () => string;
}

// ── Store path ───────────────────────────────────────────────────────────────

export function controlRequestStorePath(deps: ControlRequestDeps = {}): string {
  if (deps.requestStoreFile) return deps.requestStoreFile;
  const env = process.env.AMICO_FLEET_CONTROL_REQUEST_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-control-requests.json");
}

// ── Store key: requester+target composite ────────────────────────────────────

/** The store key is requester→target, so the same requester can request control
 *  over different targets, and different requesters can request the same target. */
function requestKey(requesterMachineId: string, targetMachineId: string): string {
  return `${requesterMachineId}::${targetMachineId}`;
}

// ── On-disk record shape ─────────────────────────────────────────────────────

interface StoredRequestRecord {
  requester_identity_key: string;
  target_machine_id: string;
  target_identity_key: string;
  status: string;
  requested_at: string;
  resolved_at?: string;
}

// ── Parse ────────────────────────────────────────────────────────────────────

function parseStored(key: string, raw: unknown): ControlRequestRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const requesterIdentityKey = typeof r.requester_identity_key === "string" ? r.requester_identity_key : "";
  const targetMachineId = typeof r.target_machine_id === "string" ? r.target_machine_id : "";
  const targetIdentityKey = typeof r.target_identity_key === "string" ? r.target_identity_key : "";
  const status = typeof r.status === "string" ? r.status : "";
  const requestedAt = typeof r.requested_at === "string" ? r.requested_at : "";
  if (!requesterIdentityKey || !targetMachineId || !requestedAt) return undefined;
  if (status !== "pending" && status !== "approved" && status !== "denied") return undefined;

  // Extract requester machine id from the composite key
  const sep = key.indexOf("::");
  const requesterMachineId = sep >= 0 ? key.slice(0, sep) : key;

  const record: ControlRequestRecord = {
    requesterMachineId,
    requesterIdentityKey,
    targetMachineId,
    targetIdentityKey,
    status,
    requestedAt,
  };
  const resolvedAt = typeof r.resolved_at === "string" ? r.resolved_at : undefined;
  if (resolvedAt) record.resolvedAt = resolvedAt;
  return record;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Read one control request by requester+target. */
export function readControlRequest(
  requesterMachineId: string,
  targetMachineId: string,
  deps: ControlRequestDeps = {},
): ControlRequestRecord | undefined {
  const collection = readKeyedCollection(controlRequestStorePath(deps), REQUESTS_COLLECTION);
  return parseStored(requestKey(requesterMachineId, targetMachineId), collection[requestKey(requesterMachineId, targetMachineId)]);
}

/** Read ALL pending requests. */
export function readPendingRequests(deps: ControlRequestDeps = {}): ControlRequestRecord[] {
  const collection = readKeyedCollection(controlRequestStorePath(deps), REQUESTS_COLLECTION);
  const out: ControlRequestRecord[] = [];
  for (const [key, raw] of Object.entries(collection)) {
    const rec = parseStored(key, raw);
    if (rec && rec.status === "pending") out.push(rec);
  }
  return out;
}

/** Read ALL requests (any status). */
export function readAllControlRequests(deps: ControlRequestDeps = {}): ControlRequestRecord[] {
  const collection = readKeyedCollection(controlRequestStorePath(deps), REQUESTS_COLLECTION);
  const out: ControlRequestRecord[] = [];
  for (const [key, raw] of Object.entries(collection)) {
    const rec = parseStored(key, raw);
    if (rec) out.push(rec);
  }
  return out;
}

// ── Writes ───────────────────────────────────────────────────────────────────

function writeRequest(record: ControlRequestRecord, deps: ControlRequestDeps): void {
  const stored: StoredRequestRecord = {
    requester_identity_key: record.requesterIdentityKey,
    target_machine_id: record.targetMachineId,
    target_identity_key: record.targetIdentityKey,
    status: record.status,
    requested_at: record.requestedAt,
  };
  if (record.resolvedAt) (stored as unknown as Record<string, unknown>).resolved_at = record.resolvedAt;
  upsertKeyedEntry(
    controlRequestStorePath(deps),
    REQUESTS_COLLECTION,
    requestKey(record.requesterMachineId, record.targetMachineId),
    stored,
    CONTROL_REQUEST_STORE_VERSION,
  );
}

// ── Submit ───────────────────────────────────────────────────────────────────

export type ControlRequestResult =
  | { ok: true; status: "pending" }
  | { ok: true; status: "already-granted" }
  | { ok: false; reason: string };

/** Submit a control request for a shared peer. If the requester already holds
 *  an active control grant for the target, returns `already-granted` (no new
 *  request). If a pending request already exists, returns `pending` (idempotent).
 *  Otherwise, creates a new pending request. */
export function submitControlRequest(
  req: ControlRequest,
  deps: ControlRequestDeps = {},
): ControlRequestResult {
  // Check if the requester already has an active control grant for the target
  const existingGrant = findControlGrantByTarget(req.targetMachineId, deps.grantDeps);
  if (existingGrant && existingGrant.requesterMachineId === req.requesterMachineId) {
    return { ok: true, status: "already-granted" };
  }

  // Check if a pending request already exists
  const existing = readControlRequest(req.requesterMachineId, req.targetMachineId, deps);
  if (existing && existing.status === "pending") {
    return { ok: true, status: "pending" };
  }

  // Create a new pending request
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const record: ControlRequestRecord = {
    requesterMachineId: req.requesterMachineId,
    requesterIdentityKey: req.requesterIdentityKey,
    targetMachineId: req.targetMachineId,
    targetIdentityKey: req.targetIdentityKey,
    status: "pending",
    requestedAt: now,
  };
  writeRequest(record, deps);
  return { ok: true, status: "pending" };
}

// ── Approve ──────────────────────────────────────────────────────────────────

export type ApproveControlResult =
  | { ok: true; grant: LifecycleGrant; status?: "already-approved" }
  | { ok: false; reason: "not-found" | "grant-failed" };

/** Approve a pending control request: mint a control grant via
 *  issueLifecycleGrant, update the request to "approved". If the request is
 *  already approved, returns the existing grant (idempotent). */
export function approveControlRequest(
  requesterMachineId: string,
  targetMachineId: string,
  deps: ControlRequestDeps = {},
): ApproveControlResult {
  const existing = readControlRequest(requesterMachineId, targetMachineId, deps);
  if (!existing) return { ok: false, reason: "not-found" };

  // Idempotent on already-approved
  if (existing.status === "approved") {
    const grant = findControlGrantByTarget(targetMachineId, deps.grantDeps);
    if (grant && grant.requesterMachineId === requesterMachineId) {
      return { ok: true, grant, status: "already-approved" };
    }
    // The request says approved but the grant is gone — re-issue
  }

  // Mint the control grant
  const grantResult = issueLifecycleGrant(
    {
      requesterMachineId,
      requesterIdentityKey: existing.requesterIdentityKey,
      targetMachineId,
      targetIdentityKey: existing.targetIdentityKey,
      scope: "control",
    },
    deps.grantDeps,
  );
  if (!grantResult.ok) {
    return { ok: false, reason: "grant-failed" };
  }

  // Update request status to approved
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const updated: ControlRequestRecord = {
    ...existing,
    status: "approved",
    resolvedAt: now,
  };
  writeRequest(updated, deps);

  return { ok: true, grant: grantResult.grant };
}

// ── Deny ─────────────────────────────────────────────────────────────────────

export type DenyControlResult =
  | { ok: true }
  | { ok: false; reason: "not-found" };

/** Deny a pending control request: update to "denied", no grant minted.
 *  Idempotent on already-denied. */
export function denyControlRequest(
  requesterMachineId: string,
  targetMachineId: string,
  deps: ControlRequestDeps = {},
): DenyControlResult {
  const existing = readControlRequest(requesterMachineId, targetMachineId, deps);
  if (!existing) return { ok: false, reason: "not-found" };

  // Idempotent on already-denied
  if (existing.status === "denied") return { ok: true };

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const updated: ControlRequestRecord = {
    ...existing,
    status: "denied",
    resolvedAt: now,
  };
  writeRequest(updated, deps);
  return { ok: true };
}
