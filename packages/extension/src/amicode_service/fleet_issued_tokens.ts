// MINTER ISSUED-TOKEN REGISTRY (#1438, ADR 0032 §D1/§D4/§D5).
//
// The minter side of the peer-trust credential: a machine is the SINGLE WRITER
// of the registry granting peer access TO ITSELF. Each issuance is recorded
// keyed by the requesting peer's `machine_id`; revocation = drop the entry AND
// bar the machine_id from re-minting (the §D4 mint-list bar, so a compromised
// machine cannot simply re-mint a fresh token after `revoke`).
//
// File: ~/.amico/fleet-peer-tokens.json, 0600, atomic — rides the SHARED
// keyed-0600-store primitive (keyed_store.ts). Two collections in one doc:
//   issued:  { <machine_id>: { token, scope, issued_at } }  — live grants
//   revoked: { <machine_id>: { revoked_at } }               — the mint-list bar
//
// The `scope` claim is RECORDED BUT INERT in v1 (ADR 0032 §D6): the accept-set
// checks membership only and never reads it. It is shaped so the Horizon-2
// engine↔engine RPC can reuse the credential without re-plumbing.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeyedCollection, upsertKeyedEntry, deleteKeyedEntry } from "./keyed_store";

export const ISSUED_TOKEN_STORE_VERSION = 1;

const ISSUED = "issued";
const REVOKED = "revoked";

export interface IssuedTokenDeps {
  /** Override the registry file (pure-injection for tests). Default:
   *  $AMICO_FLEET_ISSUED_TOKEN_FILE → ~/.amico/fleet-peer-tokens.json. */
  registryFile?: string;
  /** The token material factory (tests inject a deterministic value).
   *  Default: 32 cryptographically-random base64url bytes. */
  tokenFactory?: () => string;
  /** ISO clock for the issued_at / revoked_at stamps. Default: now. */
  now?: () => string;
  /** The recorded-but-inert scope claim (ADR 0032 §D6). Default:
   *  "full-session" — the full plane the agent already uses. */
  scope?: string;
}

export type MintPeerTokenResult =
  | { ok: true; token: string; machineId: string }
  | { ok: false; reason: "mint-barred" };

export function issuedTokenRegistryPath(deps: IssuedTokenDeps = {}): string {
  if (deps.registryFile) return deps.registryFile;
  const env = process.env.AMICO_FLEET_ISSUED_TOKEN_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-peer-tokens.json");
}

function defaultTokenFactory(): string {
  return randomBytes(32).toString("base64url");
}

/** Whether a machine_id is on the mint-list bar (revoked → refused re-mint). */
export function isMintBarred(machineId: string, deps: IssuedTokenDeps = {}): boolean {
  return machineId in readKeyedCollection(issuedTokenRegistryPath(deps), REVOKED);
}

/** Mint a per-peer token keyed by `machine_id` and record it in the issued
 *  registry. REFUSES a machine_id on the mint-list bar (§D4). */
export function mintPeerToken(machineId: string, deps: IssuedTokenDeps = {}): MintPeerTokenResult {
  const file = issuedTokenRegistryPath(deps);
  if (isMintBarred(machineId, deps)) return { ok: false, reason: "mint-barred" };
  const token = (deps.tokenFactory ?? defaultTokenFactory)();
  const issued_at = (deps.now ?? (() => new Date().toISOString()))();
  upsertKeyedEntry(file, ISSUED, machineId, { token, scope: deps.scope ?? "full-session", issued_at }, ISSUED_TOKEN_STORE_VERSION);
  return { ok: true, token, machineId };
}

/** The token this machine issued to ONE peer, or undefined. */
export function issuedTokenFor(machineId: string, deps: IssuedTokenDeps = {}): string | undefined {
  const entry = readKeyedCollection(issuedTokenRegistryPath(deps), ISSUED)[machineId];
  if (typeof entry !== "object" || entry === null) return undefined;
  const t = (entry as Record<string, unknown>).token;
  return typeof t === "string" && t !== "" ? t : undefined;
}

/** Whether this machine currently holds a live issued grant for a peer (the
 *  readiness gate's minter-side predicate). */
export function hasIssuedToken(machineId: string, deps: IssuedTokenDeps = {}): boolean {
  return issuedTokenFor(machineId, deps) !== undefined;
}

/** Every non-revoked issued token (the accept-set's per-request input). Read
 *  FRESH each call — no caching — so a revocation takes effect on the very
 *  next request (ADR 0032 §D2 currency). */
export function readIssuedTokens(deps: IssuedTokenDeps = {}): string[] {
  const issued = readKeyedCollection(issuedTokenRegistryPath(deps), ISSUED);
  const tokens: string[] = [];
  for (const entry of Object.values(issued)) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = (entry as Record<string, unknown>).token;
    if (typeof t === "string" && t !== "") tokens.push(t);
  }
  return tokens;
}

/** Revoke a peer: drop its issued grant AND add it to the mint-list bar (the
 *  LOCAL half of §D5's fan-out expulsion — each peer applies this to its own
 *  registry; no machine writes another's). */
export function revokePeerToken(machineId: string, deps: IssuedTokenDeps = {}): void {
  const file = issuedTokenRegistryPath(deps);
  deleteKeyedEntry(file, ISSUED, machineId, ISSUED_TOKEN_STORE_VERSION);
  const revoked_at = (deps.now ?? (() => new Date().toISOString()))();
  upsertKeyedEntry(file, REVOKED, machineId, { revoked_at }, ISSUED_TOKEN_STORE_VERSION);
}

/** #1480: drop an issued grant WITHOUT barring the machine_id — the ROLLBACK
 *  counterpart of a mint. Used when a reciprocal-grant transaction fails after
 *  the mint: the issued half must be undone so no half-effective grant
 *  survives, but a transient failure must NOT permanently bar a legitimate
 *  requester from re-attempting (that is what the §D4 revoke bar is for, not a
 *  rollback). Absent entry → idempotent no-op. */
export function deleteIssuedToken(machineId: string, deps: IssuedTokenDeps = {}): void {
  deleteKeyedEntry(issuedTokenRegistryPath(deps), ISSUED, machineId, ISSUED_TOKEN_STORE_VERSION);
}
