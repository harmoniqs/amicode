// CONTROL LIFECYCLE (#1486, ADR 0034 Binding Amendment 1) — the target-enforced
// Control scope, relationship generations, authority-bound revoke/re-admit, and
// durable fail-closed grants that #1480 deferred here.
//
// This module is the lifecycle state machine for fleet peer grants. It sits
// ATOP the existing keyed-store primitive and BESIDE the observe bootstrap
// (#1480) — it does NOT rebuild any foundation. The grant store is a DISTINCT
// collection (`lifecycle_grants`) so it never collides with the existing
// `issued` / `revoked` collections in fleet_issued_tokens.ts.
//
// Three scopes: observe (read-only), control (observe + session dispatch),
// lifecycle-admin (mint/revoke/re-admit authority — NOT a superset of control).
//
// Grants are bound to (requester identity, target identity, generation). A
// revoked peer's generation is bumped on re-admit so stale tokens from the
// prior generation are structurally invalid.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeyedCollection, upsertKeyedEntry } from "./keyed_store";

// ── Scope vocabulary ─────────────────────────────────────────────────────────

export const GRANT_SCOPE_VOCABULARY = ["observe", "control", "lifecycle-admin"] as const;
export type GrantScope = (typeof GRANT_SCOPE_VOCABULARY)[number];

export function isValidGrantScope(s: string): s is GrantScope {
  return (GRANT_SCOPE_VOCABULARY as readonly string[]).includes(s);
}

// ── Grant state vocabulary ───────────────────────────────────────────────────

export const GRANT_STATE_VOCABULARY = ["active", "revocation-pending", "revoked"] as const;
export type GrantState = (typeof GRANT_STATE_VOCABULARY)[number];

// ── The lifecycle grant record ───────────────────────────────────────────────

export interface LifecycleGrant {
  requesterMachineId: string;
  requesterIdentityKey: string;
  targetMachineId: string;
  targetIdentityKey: string;
  scope: GrantScope;
  generation: number;
  state: GrantState;
  token: string;
  issuedAt: string;
  revokedAt?: string;
}

// ── Store constants ──────────────────────────────────────────────────────────

export const LIFECYCLE_GRANT_STORE_VERSION = 1;
const GRANTS_COLLECTION = "lifecycle_grants";

// ── Dependencies (injectable for testing) ────────────────────────────────────

export interface LifecycleGrantDeps {
  /** Override the store file. Default:
   *  $AMICO_FLEET_LIFECYCLE_GRANT_FILE → ~/.amico/fleet-lifecycle-grants.json. */
  grantStoreFile?: string;
  /** Token material factory. Default: 32 cryptographically-random base64url bytes. */
  tokenFactory?: () => string;
  /** ISO clock. Default: now. */
  now?: () => string;
}

export function lifecycleGrantStorePath(deps: LifecycleGrantDeps = {}): string {
  if (deps.grantStoreFile) return deps.grantStoreFile;
  const env = process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-lifecycle-grants.json");
}

function defaultTokenFactory(): string {
  return randomBytes(32).toString("base64url");
}

// ── Grant store reads ────────────────────────────────────────────────────────

interface StoredGrantRecord {
  requester_identity_key: string;
  target_machine_id: string;
  target_identity_key: string;
  scope: string;
  generation: number;
  state: string;
  token: string;
  issued_at: string;
  revoked_at?: string;
}

function parseStoredGrant(peerId: string, raw: unknown): LifecycleGrant | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const requesterIdentityKey = typeof r.requester_identity_key === "string" ? r.requester_identity_key : "";
  const targetMachineId = typeof r.target_machine_id === "string" ? r.target_machine_id : "";
  const targetIdentityKey = typeof r.target_identity_key === "string" ? r.target_identity_key : "";
  const scope = typeof r.scope === "string" ? r.scope : "";
  const generation = typeof r.generation === "number" ? r.generation : 0;
  const state = typeof r.state === "string" ? r.state : "";
  const token = typeof r.token === "string" ? r.token : "";
  const issuedAt = typeof r.issued_at === "string" ? r.issued_at : "";

  if (!requesterIdentityKey || !targetMachineId || !targetIdentityKey) return undefined;
  if (!isValidGrantScope(scope)) return undefined;
  if (!isValidGrantState(state)) return undefined;
  if (generation < 1 || !token || !issuedAt) return undefined;

  const grant: LifecycleGrant = {
    requesterMachineId: peerId,
    requesterIdentityKey,
    targetMachineId,
    targetIdentityKey,
    scope,
    generation,
    state,
    token,
    issuedAt,
  };
  const revokedAt = typeof r.revoked_at === "string" ? r.revoked_at : undefined;
  if (revokedAt) grant.revokedAt = revokedAt;
  return grant;
}

function isValidGrantState(s: string): s is GrantState {
  return (GRANT_STATE_VOCABULARY as readonly string[]).includes(s);
}

/** Read the lifecycle grant for one peer, or undefined. */
export function readLifecycleGrant(peerId: string, deps: LifecycleGrantDeps = {}): LifecycleGrant | undefined {
  const collection = readKeyedCollection(lifecycleGrantStorePath(deps), GRANTS_COLLECTION);
  return parseStoredGrant(peerId, collection[peerId]);
}

/** Read ALL lifecycle grants (the route-matrix enforcement's input). */
export function readAllLifecycleGrants(deps: LifecycleGrantDeps = {}): LifecycleGrant[] {
  const collection = readKeyedCollection(lifecycleGrantStorePath(deps), GRANTS_COLLECTION);
  const grants: LifecycleGrant[] = [];
  for (const [peerId, raw] of Object.entries(collection)) {
    const g = parseStoredGrant(peerId, raw);
    if (g) grants.push(g);
  }
  return grants;
}

// ── Grant store writes ───────────────────────────────────────────────────────

function writeGrant(peerId: string, grant: LifecycleGrant, deps: LifecycleGrantDeps): void {
  const record: StoredGrantRecord = {
    requester_identity_key: grant.requesterIdentityKey,
    target_machine_id: grant.targetMachineId,
    target_identity_key: grant.targetIdentityKey,
    scope: grant.scope,
    generation: grant.generation,
    state: grant.state,
    token: grant.token,
    issued_at: grant.issuedAt,
  };
  if (grant.revokedAt) (record as unknown as Record<string, unknown>).revoked_at = grant.revokedAt;
  upsertKeyedEntry(
    lifecycleGrantStorePath(deps),
    GRANTS_COLLECTION,
    peerId,
    record,
    LIFECYCLE_GRANT_STORE_VERSION,
  );
}

// ── AC1: Atomic grant issuance ───────────────────────────────────────────────

export interface LifecycleGrantRequest {
  requesterMachineId: string;
  requesterIdentityKey: string;
  targetMachineId: string;
  targetIdentityKey: string;
  scope: GrantScope;
}

export type LifecycleGrantResult =
  | { ok: true; grant: LifecycleGrant }
  | { ok: false; reason: "identity-mismatch" | "target-mismatch" | "revoked" };

/** Issue a lifecycle grant — ATOMIC: the entire read-check-write is one
 *  synchronous critical section (no `await` between check and write). On first
 *  issue, generation=1. On re-issue for the same identity, the existing
 *  generation is preserved (a token refresh). On identity MISMATCH, refused —
 *  a different peer claiming the same machine_id cannot usurp an existing grant.
 *  A revoked grant blocks re-issuance (use readmitPeer to re-admit). */
export function issueLifecycleGrant(
  req: LifecycleGrantRequest,
  deps: LifecycleGrantDeps = {},
): LifecycleGrantResult {
  const existing = readLifecycleGrant(req.requesterMachineId, deps);

  if (existing) {
    // Identity binding: the same machine_id with a DIFFERENT identity_key is
    // refused — no usurpation of an existing grant.
    if (existing.requesterIdentityKey !== req.requesterIdentityKey) {
      return { ok: false, reason: "identity-mismatch" };
    }
    // A revoked grant blocks re-issuance — use readmitPeer instead.
    if (existing.state === "revoked") {
      return { ok: false, reason: "revoked" };
    }
  }

  const generation = existing?.generation ?? 1;
  const token = (deps.tokenFactory ?? defaultTokenFactory)();
  const issuedAt = (deps.now ?? (() => new Date().toISOString()))();

  const grant: LifecycleGrant = {
    requesterMachineId: req.requesterMachineId,
    requesterIdentityKey: req.requesterIdentityKey,
    targetMachineId: req.targetMachineId,
    targetIdentityKey: req.targetIdentityKey,
    scope: req.scope,
    generation,
    state: "active",
    token,
    issuedAt,
  };

  writeGrant(req.requesterMachineId, grant, deps);
  return { ok: true, grant };
}

// ── AC2: Route matrix enforcement ────────────────────────────────────────────

/** The route matrix: which scopes are allowed on which routes. The matrix is
 *  a pure function — no I/O, no store reads. It is the SAME decision at both
 *  the service boundary (server.ts) and the engine boundary (overlay auth.ts).
 *
 *  observe:         read-only fleet routes (/amicode/fleet/status, /sessions, /roster GET)
 *  control:         observe + session control routes (POST dispatch, solve, etc.)
 *  lifecycle-admin: lifecycle mutation routes ONLY (mint, revoke, re-admit)
 *
 *  The matrix is DENY-default: an unrecognized route or scope is denied. */

const OBSERVE_PREFIXES = [
  "/amicode/fleet/status",
  "/amicode/fleet/sessions",
  "/amicode/fleet/roster",
];

const CONTROL_PREFIXES = [
  ...OBSERVE_PREFIXES,
  "/amicode/fleet/dispatch",
  "/amicode/fleet/solve",
  "/amicode/fleet/session-control",
  // Proxied session routes (the session itself)
  "/session",
  "/pty/",
];

const LIFECYCLE_ADMIN_PREFIXES = [
  "/amicode/fleet/peer-token",
  "/amicode/fleet/revoke",
  "/amicode/fleet/readmit",
  "/amicode/fleet/lifecycle",
];

/** Evaluate whether a scope is authorized for a given method+pathname.
 *  Pure: no I/O, no store reads — the route-matrix decision. */
export function evaluateRouteMatrix(scope: GrantScope, method: string, pathname: string): boolean {
  switch (scope) {
    case "observe":
      return matchesPrefixes(OBSERVE_PREFIXES, pathname) && isReadMethod(method);
    case "control":
      return matchesPrefixes(CONTROL_PREFIXES, pathname);
    case "lifecycle-admin":
      return matchesPrefixes(LIFECYCLE_ADMIN_PREFIXES, pathname);
    default:
      return false;
  }
}

function matchesPrefixes(prefixes: string[], pathname: string): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p));
}

function isReadMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

// ── AC3: Lifecycle authority ─────────────────────────────────────────────────

export interface LifecycleAuthorityDeps {
  /** The lifecycle authority's identity_key (the keeper's fingerprint). */
  authorityIdentityKey: string;
  /** The local service mint (always an authority). */
  localServiceMint: string;
}

/** Whether the presented credential identifies a lifecycle authority. Only a
 *  lifecycle authority can mint, revoke, or re-admit. Control and Observe
 *  credentials CANNOT mutate lifecycle state — this is the AC3 gate. */
export function isLifecycleAuthority(
  presented: { identityKey?: string; credential?: string },
  deps: LifecycleAuthorityDeps,
): boolean {
  if (presented.identityKey === deps.authorityIdentityKey) return true;
  if (presented.credential !== undefined && presented.credential === deps.localServiceMint) return true;
  return false;
}

// ── AC4: Revoke / acknowledge / re-admit ─────────────────────────────────────

export type RevokeResult =
  | { ok: true; state: "revocation-pending"; generation: number }
  | { ok: false; reason: "not-found" | "already-revoked" };

/** Revoke a peer's grant: transition from `active` → `revocation-pending`.
 *  A non-acknowledging peer stays revocation-pending — NEVER falsely complete.
 *  Idempotent on revocation-pending. Refuses if already fully revoked
 *  (use readmitPeer). */
export function revokeLifecycleGrant(
  peerId: string,
  deps: LifecycleGrantDeps = {},
): RevokeResult {
  const existing = readLifecycleGrant(peerId, deps);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.state === "revoked") return { ok: false, reason: "already-revoked" };

  // Idempotent on revocation-pending
  if (existing.state === "revocation-pending") {
    return { ok: true, state: "revocation-pending", generation: existing.generation };
  }

  const revokedAt = (deps.now ?? (() => new Date().toISOString()))();
  const updated: LifecycleGrant = { ...existing, state: "revocation-pending", revokedAt };
  writeGrant(peerId, updated, deps);
  return { ok: true, state: "revocation-pending", generation: existing.generation };
}

export type AcknowledgeResult =
  | { ok: true; state: "revoked" }
  | { ok: false; reason: "not-found" | "not-pending" };

/** Acknowledge a revocation: transition from `revocation-pending` → `revoked`.
 *  This is the peer's acknowledgment that it has stopped using the grant. */
export function acknowledgeRevocation(
  peerId: string,
  deps: LifecycleGrantDeps = {},
): AcknowledgeResult {
  const existing = readLifecycleGrant(peerId, deps);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.state !== "revocation-pending") return { ok: false, reason: "not-pending" };

  const updated: LifecycleGrant = { ...existing, state: "revoked" };
  writeGrant(peerId, updated, deps);
  return { ok: true, state: "revoked" };
}

export interface ReadmitRequest {
  peerId: string;
  /** The target must explicitly approve the re-admission. */
  targetApproved: boolean;
  /** The scope for the re-admitted grant. */
  scope: GrantScope;
  /** The requester's current identity_key (must match the revoked grant's). */
  requesterIdentityKey: string;
  targetMachineId: string;
  targetIdentityKey: string;
}

export type ReadmitResult =
  | { ok: true; grant: LifecycleGrant }
  | { ok: false; reason: "not-found" | "not-revoked" | "approval-required" | "identity-mismatch" };

/** Re-admit a revoked peer: creates a NEW generation, requiring target
 *  approval. The old generation's token is structurally invalid after the
 *  bump. */
export function readmitPeer(
  req: ReadmitRequest,
  deps: LifecycleGrantDeps = {},
): ReadmitResult {
  const existing = readLifecycleGrant(req.peerId, deps);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.state !== "revoked") return { ok: false, reason: "not-revoked" };
  if (!req.targetApproved) return { ok: false, reason: "approval-required" };
  if (existing.requesterIdentityKey !== req.requesterIdentityKey) {
    return { ok: false, reason: "identity-mismatch" };
  }

  const newGeneration = existing.generation + 1;
  const token = (deps.tokenFactory ?? defaultTokenFactory)();
  const issuedAt = (deps.now ?? (() => new Date().toISOString()))();

  const grant: LifecycleGrant = {
    requesterMachineId: req.peerId,
    requesterIdentityKey: req.requesterIdentityKey,
    targetMachineId: req.targetMachineId,
    targetIdentityKey: req.targetIdentityKey,
    scope: req.scope,
    generation: newGeneration,
    state: "active",
    token,
    issuedAt,
  };

  writeGrant(req.peerId, grant, deps);
  return { ok: true, grant };
}

// ── AC4 + AC1: Grant validation (generation + state check) ───────────────────

export interface ValidateGrantResult {
  valid: boolean;
  reason?: "not-found" | "revoked" | "revocation-pending" | "stale-generation" | "wrong-token";
}

/** Validate a presented grant token against the stored grant — checks state,
 *  generation, and token match. A stale-generation token (from before a
 *  re-admit) is structurally invalid. */
export function validateLifecycleGrant(
  peerId: string,
  presentedToken: string,
  presentedGeneration: number,
  deps: LifecycleGrantDeps = {},
): ValidateGrantResult {
  const stored = readLifecycleGrant(peerId, deps);
  if (!stored) return { valid: false, reason: "not-found" };
  if (stored.state === "revoked") return { valid: false, reason: "revoked" };
  if (stored.state === "revocation-pending") return { valid: false, reason: "revocation-pending" };
  if (presentedGeneration !== stored.generation) return { valid: false, reason: "stale-generation" };
  if (presentedToken !== stored.token) return { valid: false, reason: "wrong-token" };
  return { valid: true };
}

// ── AC2 integration: token→scope reverse lookup + composed scope enforcement ─

/** Find the lifecycle grant that issued a given token. The reverse lookup used
 *  at the boundary to determine which scope a presenting peer carries. Returns
 *  the grant if found and active, undefined otherwise. The lookup reads ALL
 *  grants (small set — fleet-scale, not internet-scale). */
export function findGrantByToken(
  presentedToken: string,
  deps: LifecycleGrantDeps = {},
): LifecycleGrant | undefined {
  const all = readAllLifecycleGrants(deps);
  return all.find((g) => g.token === presentedToken && g.state === "active");
}

/** The composed scope enforcement: given a presented token + request, evaluate
 *  BOTH membership (the token is a valid active grant) AND scope (the route
 *  matrix allows this scope on this route). This is the SAME function called at
 *  both service and engine boundaries — a PURE composition of the two checks,
 *  deterministic on the same store state. */
export function enforceScopeForRequest(
  presentedToken: string,
  method: string,
  pathname: string,
  deps: LifecycleGrantDeps = {},
): { allowed: boolean; scope?: GrantScope; reason?: string } {
  const grant = findGrantByToken(presentedToken, deps);
  if (!grant) return { allowed: false, reason: "no-active-grant" };
  if (!evaluateRouteMatrix(grant.scope, method, pathname)) {
    return { allowed: false, scope: grant.scope, reason: "scope-denied" };
  }
  return { allowed: true, scope: grant.scope };
}

// ── AC5: Secret sanitization ─────────────────────────────────────────────────

/** Produce a SAFE representation of a grant for status/UI/logging — the token
 *  is NEVER included, and identity keys are truncated to the first 8 chars. */
export function sanitizeGrantForDisplay(grant: LifecycleGrant): Record<string, unknown> {
  return {
    requesterMachineId: grant.requesterMachineId,
    requesterIdentityKey: grant.requesterIdentityKey.slice(0, 16) + "…",
    targetMachineId: grant.targetMachineId,
    scope: grant.scope,
    generation: grant.generation,
    state: grant.state,
    issuedAt: grant.issuedAt,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
  };
}
