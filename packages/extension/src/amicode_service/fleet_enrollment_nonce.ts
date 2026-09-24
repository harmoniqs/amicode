// ENROLLMENT NONCE (#1438, ADR 0032 §D4) — the single-use, short-TTL bootstrap
// credential a joining machine uses to obtain its FIRST peer token from the
// mint endpoint.
//
// Deliberately NOT the standing Fleet token (which guards enrollment) and NOT a
// long-lived machine-scoped secret: a nonce is minted for one specific join,
// expires quickly, and is consumed on first use. This closes the revocation
// hole — a compromised machine cannot re-mint a peer token around `revoke`,
// because the bootstrap it would need is a one-shot nonce, not a re-usable key.
//
// File: ~/.amico/fleet-enrollment-nonces.json, 0600 — rides the shared
// keyed-0600-store primitive (keyed_store.ts), collection "nonces":
//   { <nonce>: { expires_at, used } }
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeyedCollection, upsertKeyedEntry } from "./keyed_store";

export const ENROLLMENT_NONCE_STORE_VERSION = 1;
/** The default nonce lifetime — short by design (§D4). */
export const ENROLLMENT_NONCE_DEFAULT_TTL_MS = 5 * 60 * 1000;

const NONCES = "nonces";

export interface EnrollmentNonceDeps {
  /** Override the store file (pure-injection for tests). Default:
   *  $AMICO_FLEET_ENROLLMENT_NONCE_FILE → ~/.amico/fleet-enrollment-nonces.json. */
  storeFile?: string;
  /** Epoch-ms clock. Default: Date.now. */
  now?: () => number;
  /** Nonce lifetime in ms (mint only). Default: ENROLLMENT_NONCE_DEFAULT_TTL_MS. */
  ttlMs?: number;
  /** Nonce material factory (tests inject a deterministic value). Default:
   *  32 cryptographically-random base64url bytes. */
  nonceFactory?: () => string;
}

export function enrollmentNonceStorePath(deps: EnrollmentNonceDeps = {}): string {
  if (deps.storeFile) return deps.storeFile;
  const env = process.env.AMICO_FLEET_ENROLLMENT_NONCE_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-enrollment-nonces.json");
}

function readNonce(nonce: string, deps: EnrollmentNonceDeps): { expires_at: number; used: boolean } | undefined {
  const entry = readKeyedCollection(enrollmentNonceStorePath(deps), NONCES)[nonce];
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const expires_at = typeof e.expires_at === "number" ? e.expires_at : NaN;
  const used = e.used === true;
  if (!Number.isFinite(expires_at)) return undefined;
  return { expires_at, used };
}

/** Mint a fresh single-use nonce with a short TTL; returns the nonce value. */
export function mintEnrollmentNonce(deps: EnrollmentNonceDeps = {}): string {
  const now = (deps.now ?? Date.now)();
  const ttl = deps.ttlMs ?? ENROLLMENT_NONCE_DEFAULT_TTL_MS;
  const nonce = (deps.nonceFactory ?? (() => randomBytes(32).toString("base64url")))();
  upsertKeyedEntry(
    enrollmentNonceStorePath(deps),
    NONCES,
    nonce,
    { expires_at: now + ttl, used: false },
    ENROLLMENT_NONCE_STORE_VERSION,
  );
  return nonce;
}

/** Whether a nonce is presently redeemable — present, unused, unexpired. Does
 *  NOT consume it (so authorized() can check a probe without side effects). */
export function validateEnrollmentNonce(nonce: string, deps: EnrollmentNonceDeps = {}): boolean {
  const rec = readNonce(nonce, deps);
  if (rec === undefined) return false;
  if (rec.used) return false;
  return (deps.now ?? Date.now)() <= rec.expires_at;
}

/** Redeem a nonce single-use: validate AND mark it used (returns whether the
 *  redemption succeeded). Called at mint time by the mint-endpoint handler. */
export function consumeEnrollmentNonce(nonce: string, deps: EnrollmentNonceDeps = {}): boolean {
  if (!validateEnrollmentNonce(nonce, deps)) return false;
  const rec = readNonce(nonce, deps)!;
  upsertKeyedEntry(
    enrollmentNonceStorePath(deps),
    NONCES,
    nonce,
    { expires_at: rec.expires_at, used: true },
    ENROLLMENT_NONCE_STORE_VERSION,
  );
  return true;
}

// ── IDENTITY-BOUND enrollment nonce (#1480, ADR 0034) ────────────────────────
// The #1475 trust audit found the #1438 nonce above URL-carried, identity-
// UNBOUND, and non-transactional. This is the FIX for the Observe bootstrap
// path: a nonce minted here is BOUND to (target, requesting identity_key) —
// redemption requires the SAME target+identity, and the consume is a single
// synchronous read-check-write critical section (no `await` between the used
// check and the used write), so two concurrent redemptions of one nonce can
// never both mint. It rides the same 0600 keyed store, a distinct collection
// so a bound record is never mistaken for an unbound one.

const BOUND_NONCES = "bound_nonces";

/** The binding a bound nonce is minted for and redeemed against: the target
 *  machine the joiner is enrolling WITH, and the joiner's stable identity_key
 *  fingerprint (#1477). Both must match at redemption. */
export interface NonceBinding {
  /** The target machine_id the nonce authorizes bootstrap toward. */
  target: string;
  /** The requesting peer's stable identity_key (#1477 fingerprint). */
  identityKey: string;
}

interface BoundNonceRecord {
  expires_at: number;
  used: boolean;
  target: string;
  identity_key: string;
}

function readBoundNonce(nonce: string, deps: EnrollmentNonceDeps): BoundNonceRecord | undefined {
  const entry = readKeyedCollection(enrollmentNonceStorePath(deps), BOUND_NONCES)[nonce];
  if (typeof entry !== "object" || entry === null) return undefined;
  const e = entry as Record<string, unknown>;
  const expires_at = typeof e.expires_at === "number" ? e.expires_at : NaN;
  const target = typeof e.target === "string" ? e.target : "";
  const identity_key = typeof e.identity_key === "string" ? e.identity_key : "";
  if (!Number.isFinite(expires_at) || target === "" || identity_key === "") return undefined;
  return { expires_at, used: e.used === true, target, identity_key };
}

/** Mint a fresh single-use nonce BOUND to a (target, identity_key). Returns the
 *  nonce value — the CALLER carries it OFF the URL (a request header / body),
 *  never a query string (AC1). */
export function mintBoundEnrollmentNonce(binding: NonceBinding, deps: EnrollmentNonceDeps = {}): string {
  const now = (deps.now ?? Date.now)();
  const ttl = deps.ttlMs ?? ENROLLMENT_NONCE_DEFAULT_TTL_MS;
  const nonce = (deps.nonceFactory ?? (() => randomBytes(32).toString("base64url")))();
  upsertKeyedEntry(
    enrollmentNonceStorePath(deps),
    BOUND_NONCES,
    nonce,
    { expires_at: now + ttl, used: false, target: binding.target, identity_key: binding.identityKey },
    ENROLLMENT_NONCE_STORE_VERSION,
  );
  return nonce;
}

/** Whether a bound nonce is presently redeemable FOR THIS binding — present,
 *  unused, unexpired, AND bound to the SAME target and identity_key. A wrong
 *  target or wrong identity is a miss (never a match). Does NOT consume. */
export function validateBoundEnrollmentNonce(nonce: string, binding: NonceBinding, deps: EnrollmentNonceDeps = {}): boolean {
  const rec = readBoundNonce(nonce, deps);
  if (rec === undefined) return false;
  if (rec.used) return false;
  if (rec.target !== binding.target || rec.identity_key !== binding.identityKey) return false;
  return (deps.now ?? Date.now)() <= rec.expires_at;
}

/** Redeem a bound nonce single-use FOR THIS binding: validate against the
 *  target+identity AND mark it used, as ONE synchronous read-check-write
 *  critical section. Because there is no `await` between the used check and the
 *  used write, two concurrent redemptions of the same nonce cannot both pass —
 *  the event loop serializes them, so exactly one wins (atomic consume, AC2). A
 *  wrong-identity/wrong-target attempt returns false WITHOUT burning the nonce,
 *  so the rightful owner can still redeem it. */
export function consumeBoundEnrollmentNonce(nonce: string, binding: NonceBinding, deps: EnrollmentNonceDeps = {}): boolean {
  const rec = readBoundNonce(nonce, deps);
  if (rec === undefined) return false;
  if (rec.used) return false;
  if (rec.target !== binding.target || rec.identity_key !== binding.identityKey) return false;
  if ((deps.now ?? Date.now)() > rec.expires_at) return false;
  upsertKeyedEntry(
    enrollmentNonceStorePath(deps),
    BOUND_NONCES,
    nonce,
    { expires_at: rec.expires_at, used: true, target: rec.target, identity_key: rec.identity_key },
    ENROLLMENT_NONCE_STORE_VERSION,
  );
  return true;
}
