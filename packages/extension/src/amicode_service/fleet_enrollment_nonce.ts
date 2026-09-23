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
