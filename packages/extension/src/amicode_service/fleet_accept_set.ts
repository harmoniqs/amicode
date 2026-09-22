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
import { validateEnrollmentNonce } from "./fleet_enrollment_nonce";
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
  for (const row of deps.rosterRows) {
    const d = placementDescriptor(row);
    if (!d.serving || !d.reachable) continue;
    const machineId = d.machine_id?.trim() ?? "";
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
