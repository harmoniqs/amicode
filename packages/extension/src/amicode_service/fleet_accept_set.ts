// THE ACCEPT-SET (#1438, ADR 0032 §D2/§D3) — the boundary predicate that
// replaces full `auth=open`, plus the staged-rollout phase state, the readiness
// gate that guards the close, and the reader-side outcome classification.
//
// Two boundaries, one accept-set (§D2): the service boundary (server.ts
// authorized()) and the engine overlay (overlay/.../server/auth.ts) both
// validate the SAME membership predicate against the SAME on-disk stores. This
// module is the service side; the engine overlay reads the same files with its
// own self-contained reader (it cannot import the extension package).
//
// The phase is persisted in a tiny state file and read PER REQUEST, so a close
// or a rollback takes effect on the immediately-following request with no
// in-memory cache (§D2 currency + the documented rollback, §D3).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync } from "./credentials";
import type { AcceptSet } from "./server";
import { readIssuedTokens } from "./fleet_issued_tokens";
import { validateEnrollmentNonce, validateBoundEnrollmentNonce } from "./fleet_enrollment_nonce";
import { hasIssuedToken } from "./fleet_issued_tokens";
import { hasPeerToken } from "./fleet_peer_store";
import { placementDescriptor, type RosterRow } from "@amicode/schema";

export type AcceptSetPhase = "additive" | "closed";

/** The mint endpoint — the ONE bearer-less path a joining machine reaches
 *  (§D4). Lives under /amicode/fleet/* (the machine's own honesty surface,
 *  never proxied). */
export const MINT_ENDPOINT_PATH = "/amicode/fleet/peer-token";

export interface AcceptSetStateDeps {
  /** Override the phase state file. Default:
   *  $AMICO_FLEET_ACCEPT_SET_FILE → ~/.amico/fleet-accept-set.json. */
  phaseStateFile?: string;
}

export function acceptSetStatePath(deps: AcceptSetStateDeps = {}): string {
  if (deps.phaseStateFile) return deps.phaseStateFile;
  const env = process.env.AMICO_FLEET_ACCEPT_SET_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-accept-set.json");
}

/** The current accept-set phase — read fresh (no cache). Absent/corrupt →
 *  the safe default `additive` (a half-migrated fleet is never locked out). */
export function acceptSetPhase(deps: AcceptSetStateDeps = {}): AcceptSetPhase {
  const file = acceptSetStatePath(deps);
  if (!existsSync(file)) return "additive";
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { phase?: unknown };
    return doc.phase === "closed" ? "closed" : "additive";
  } catch {
    return "additive";
  }
}

/** Close the boundary (§D3.2) — flip to `closed`, withdrawing auth=open AND the
 *  transitional hub credential in the same step. CALLERS must gate this on
 *  `evaluateReadiness(...).closeable` first; this write does not re-check (the
 *  gate is a separate, testable predicate). */
export function closeAcceptSet(deps: AcceptSetStateDeps = {}): void {
  atomicWriteFileSync(acceptSetStatePath(deps), JSON.stringify({ phase: "closed" }, null, 2) + "\n");
}

/** The documented rollback (§D3) — re-open the additive posture if a peer is
 *  stranded post-close. Deterministic: the stranded peer's request that 401'd
 *  under `closed` authenticates again (anonymous / hub credential accepted). */
export function rollbackAcceptSet(deps: AcceptSetStateDeps = {}): void {
  atomicWriteFileSync(acceptSetStatePath(deps), JSON.stringify({ phase: "additive" }, null, 2) + "\n");
}

export interface BuildAcceptSetDeps {
  issuedRegistryFile?: string;
  phaseStateFile?: string;
  enrollmentNonceFile?: string;
  /** The transitional hub credential token (additive only). */
  hubCredentialToken?: () => string | undefined;
  /** Override the mint endpoint path (default MINT_ENDPOINT_PATH). */
  mintEndpointPath?: string;
  /** #1480: this machine's own machine_id — the `target` a bound Observe
   *  bootstrap nonce must be bound to (a joiner enrolls WITH this machine).
   *  Absent → the bound path never matches (only the legacy unbound path). */
  selfMachineId?: string;
}

/** Build the AcceptSet the service boundary consumes. Every method reads its
 *  backing store FRESH so the boundary is per-request (§D2). */
export function buildAcceptSet(deps: BuildAcceptSetDeps = {}): AcceptSet {
  const mintPath = deps.mintEndpointPath ?? MINT_ENDPOINT_PATH;
  return {
    phase: () => acceptSetPhase({ phaseStateFile: deps.phaseStateFile }),
    issuedTokens: () => readIssuedTokens({ registryFile: deps.issuedRegistryFile }),
    hubCredentialToken: () => deps.hubCredentialToken?.(),
    isMintEndpoint: (method, pathname) => method === "POST" && pathname === mintPath,
    validateNonce: (nonce) => validateEnrollmentNonce(nonce, { storeFile: deps.enrollmentNonceFile }),
    // #1480: the OFF-URL bound Observe bootstrap path — validate the nonce
    // against THIS machine as target and the requesting identity_key (read
    // fresh per request, §D2). Consume happens in the mint handler.
    validateBoundNonce: (nonce, target, identityKey) =>
      validateBoundEnrollmentNonce(nonce, { target, identityKey }, { storeFile: deps.enrollmentNonceFile }),
    selfMachineId: () => deps.selfMachineId,
  };
}

// ── the reader-side outcome classification (ADR 0032 §D5 / AC2) ──────────────
// A revoked token 401s on its next request; the reader surfaces that peer
// DISTINCTLY as revoked (NoPermissions) — never conflated with an unreachable
// peer (HubDown). This is the app-layer accept-set split, NOT the transport-
// layer read-only-with-pointer credential-lapse model the PRD rejected.

export const PEER_OUTCOME_NO_PERMISSIONS = "NoPermissions";
export const PEER_OUTCOME_HUB_DOWN = "HubDown";

export type PeerOutcome =
  | { kind: "authorized" }
  | { kind: "revoked"; outcome: typeof PEER_OUTCOME_NO_PERMISSIONS }
  | { kind: "unreachable"; outcome: typeof PEER_OUTCOME_HUB_DOWN };

/** Classify the reader's outbound peer hop: a 401/403 is REVOCATION
 *  (NoPermissions — a suspected compromise reads as revocation, not an
 *  outage); a transport failure is UNREACHABILITY (HubDown). Two DISTINCT
 *  external outcomes, never conflated. */
export function classifyPeerOutcome(input: { httpStatus?: number; transportError?: boolean }): PeerOutcome {
  if (input.transportError) return { kind: "unreachable", outcome: PEER_OUTCOME_HUB_DOWN };
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return { kind: "revoked", outcome: PEER_OUTCOME_NO_PERMISSIONS };
  }
  if (input.httpStatus !== undefined && input.httpStatus >= 200 && input.httpStatus < 300) {
    return { kind: "authorized" };
  }
  // Any other status is a reachable-but-not-ok answer — the peer responded, so
  // it is not down; treat as revocation-class (NoPermissions) rather than an
  // outage, so a suspected compromise never masquerades as HubDown.
  return { kind: "revoked", outcome: PEER_OUTCOME_NO_PERMISSIONS };
}

// ── the readiness gate (ADR 0032 §D3.2 / AC6) ────────────────────────────────

export interface ReadinessDeps {
  /** The roster (read-only, ADR 0026 — the gate reads, writes no row). */
  rosterRows: RosterRow[];
  /** This machine's issued-token registry file. */
  issuedRegistryFile?: string;
  /** This machine's reader peer-store file. */
  peerStoreFile?: string;
  /** This machine's own machine_id — excluded from the serving-peer set (a
   *  machine does not gate on holding a token to itself). */
  selfMachineId?: string;
}

export interface ReadinessBlocker {
  machine_id?: string;
  reason: "unresolvable-machine-id" | "missing-issued-token" | "missing-peer-token";
}

export type ReadinessVerdict =
  | { closeable: true; resolved: string[] }
  | { closeable: false; blockers: ReadinessBlocker[] };

/** One serving∧reachable roster row resolved to its (trimmed) `machine_id`.
 *  `machineId === ""` marks a serving∧reachable row whose id could not be
 *  resolved — the caller decides whether that refuses close (readiness) or is
 *  simply skipped (the peer provider). */
export interface ServingPeer {
  machineId: string;
}

/** The identity states that BLOCK peer selection (#1477, ADR 0034):
 *  alias-conflict and key-changed are trust-breaking — a peer in these
 *  states must not be selected for service routing until explicitly re-admitted.
 *  stale-alias is informational (non-blocking); verified and absent pass. */
const BLOCKING_IDENTITY_STATES: ReadonlySet<string> = new Set(["alias-conflict", "key-changed"]);

/** The ONE serving∧reachable resolution (§D3.2): every roster row with
 *  `capabilities ∋ serving` ∧ `health = reachable`, in roster order, resolved
 *  to its trimmed `machine_id` (`""` when unresolvable). Both the readiness
 *  gate AND the fleet-peer provider (#1446) read the serving peer set through
 *  this single derivation rather than re-deriving `placementDescriptor` twice
 *  with subtly different rules. #1477: rows with a blocking identity_state
 *  (alias-conflict, key-changed) are EXCLUDED — no conflicted row reaches
 *  peer selection. Pure: no store reads, no I/O. */
export function servingReachablePeers(rosterRows: RosterRow[]): ServingPeer[] {
  const out: ServingPeer[] = [];
  for (const row of rosterRows) {
    const d = placementDescriptor(row);
    if (!d.serving || !d.reachable) continue;
    // #1477: exclude peers with blocking identity states
    if (row.identity_state && BLOCKING_IDENTITY_STATES.has(row.identity_state)) continue;
    out.push({ machineId: d.machine_id?.trim() ?? "" });
  }
  return out;
}

/** Resolve every roster row with `capabilities ∋ serving` ∧ `health = reachable`
 *  to its `machine_id`; close is permitted IFF, for every such machine_id
 *  (other than self), BOTH this machine's issued-token registry AND its reader
 *  peer-store hold a non-revoked entry. A serving row whose machine_id cannot
 *  be resolved REFUSES close (never satisfies it vacuously). Both sides of the
 *  comparison are keyed on machine_id (single vocabulary). LOCAL: reads only
 *  this machine's two stores. */
export function evaluateReadiness(deps: ReadinessDeps): ReadinessVerdict {
  const blockers: ReadinessBlocker[] = [];
  const resolved: string[] = [];
  for (const { machineId } of servingReachablePeers(deps.rosterRows)) {
    if (machineId === "") {
      blockers.push({ reason: "unresolvable-machine-id" });
      continue;
    }
    if (deps.selfMachineId !== undefined && machineId === deps.selfMachineId) continue;
    if (!hasIssuedToken(machineId, { registryFile: deps.issuedRegistryFile })) {
      blockers.push({ machine_id: machineId, reason: "missing-issued-token" });
    }
    if (!hasPeerToken(machineId, { storeFile: deps.peerStoreFile })) {
      blockers.push({ machine_id: machineId, reason: "missing-peer-token" });
    }
    if (!blockers.some((b) => b.machine_id === machineId)) resolved.push(machineId);
  }
  if (blockers.length > 0) return { closeable: false, blockers };
  return { closeable: true, resolved };
}
