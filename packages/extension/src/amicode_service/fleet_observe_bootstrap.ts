// OBSERVE-SCOPE BOOTSTRAP (#1480, ADR 0034) — the AC3 eligibility decision and
// the reciprocal Observe grant issuance, with ATOMIC issuer mutation.
//
// SCOPE (binding amendment): this module is the identity-bound OBSERVE bootstrap
// only. Target-enforced CONTROL scope, lifecycle authority, revoke/re-admit, and
// relationship generations are DEFERRED to #1486 — those requirements supersede
// any broad wording here. A natural Control seam is marked with a #1486 comment
// and deliberately NOT implemented.
//
// AC3: "a self-owned peer can establish reciprocal Observe trust through verified
// management access; a shared peer requires target-side approval." The decision
// is a PURE predicate (no I/O) so it is trivially testable and never entangled
// with the #1486 lifecycle authority; the issuance is the mutation that composes
// the existing minter registry + reader peer-store primitives.
import { mintPeerToken, deleteIssuedToken, type IssuedTokenDeps } from "./fleet_issued_tokens";
import { writePeerToken, clearPeerToken, type PeerStoreDeps } from "./fleet_peer_store";

/** Whether the requesting peer is the SAME operator's own machine (`self-owned`)
 *  or a DIFFERENT operator's machine shared into the fleet (`shared`). This is
 *  an input to the decision, established upstream (the enrollment context) —
 *  the fuller ownership model / lifecycle authority is #1486's. */
export type PeerOwnership = "self-owned" | "shared";

/** The AC3 decision inputs. `managementVerified` is the "verified management
 *  access" the self-owned fast path requires; `targetApproved` is the target-
 *  side approval the shared path requires. */
export interface ObserveBootstrapRequest {
  ownership: PeerOwnership;
  /** Verified management access to the requesting machine (the self-owned
   *  fast-path gate). */
  managementVerified: boolean;
  /** The target operator explicitly approved this bootstrap (the shared-path
   *  gate). */
  targetApproved: boolean;
}

/** The AC3 outcome. `reciprocal-observe` = establish reciprocal Observe now;
 *  `requires-approval` = hold for target-side approval (the shared path, or a
 *  self-owned peer lacking verified management access). Note there is NO
 *  `control` outcome here — Control scope is #1486. */
export type ObserveBootstrapDecision =
  | { decision: "reciprocal-observe" }
  | { decision: "requires-approval" };

/** AC3, pure: a SELF-OWNED peer with VERIFIED MANAGEMENT ACCESS establishes
 *  reciprocal Observe automatically; every other case (a shared peer, or a
 *  self-owned peer without verified management access) requires explicit
 *  target-side approval. Management access is NOT a substitute for a shared
 *  peer's approval — ownership must be self-owned for the fast path, so a
 *  shared peer can never borrow it (no privilege bleed). */
export function evaluateObserveBootstrap(req: ObserveBootstrapRequest): ObserveBootstrapDecision {
  if (req.ownership === "self-owned" && req.managementVerified) {
    return { decision: "reciprocal-observe" };
  }
  if (req.targetApproved) {
    return { decision: "reciprocal-observe" };
  }
  return { decision: "requires-approval" };
}

// ── reciprocal Observe grant issuance (atomic issuer mutation) ───────────────

export interface ReciprocalObserveGrant {
  /** The requesting peer's machine_id — the key both stores are keyed on. */
  requesterMachineId: string;
  /** The requester's base_url (so this machine can reach it back). */
  peerBaseUrl: string;
  /** The token the requester minted FOR THIS machine (the reciprocal half —
   *  what we persist locally so we hold Observe access back to them). */
  reciprocalToken: string;
}

export interface ReciprocalObserveDeps {
  issuedRegistryFile?: string;
  peerStoreFile?: string;
  /** Token material factory for the Observe grant we mint to the requester. */
  tokenFactory?: () => string;
  /** Persist the local reciprocal grant — injectable so a failure can be
   *  exercised (the rollback path). Default: writePeerToken. */
  persistLocalGrant?: (grant: ReciprocalObserveGrant, deps: PeerStoreDeps) => void;
}

export type ReciprocalObserveResult =
  | { ok: true; token: string; scope: "observe" }
  | { ok: false; reason: "mint-barred" | "persist-failed" };

/** Establish the reciprocal Observe relationship as ONE atomic issuer mutation:
 *  (1) mint an OBSERVE-scoped grant to the requester (our issued registry) and
 *  (2) persist the requester's reciprocal token locally (our reader peer-store).
 *  If EITHER half fails, NEITHER survives — a barred requester never gets step
 *  (1); a step-(2) failure ROLLS BACK step (1) (a plain issued-entry delete,
 *  NOT a §D4 bar — a transient failure must not permanently bar a legitimate
 *  requester). This upholds the invariant "a failed lifecycle transition leaves
 *  no half-effective grant" for the Observe bootstrap. */
export function issueReciprocalObserveGrant(
  grant: ReciprocalObserveGrant,
  deps: ReciprocalObserveDeps = {},
): ReciprocalObserveResult {
  const issuedDeps: IssuedTokenDeps = {
    ...(deps.issuedRegistryFile !== undefined ? { registryFile: deps.issuedRegistryFile } : {}),
    ...(deps.tokenFactory !== undefined ? { tokenFactory: deps.tokenFactory } : {}),
    // #1480 issues an OBSERVE grant; Control scope is #1486's.
    scope: "observe",
  };
  const peerDeps: PeerStoreDeps = deps.peerStoreFile !== undefined ? { storeFile: deps.peerStoreFile } : {};

  // Step 1: mint the Observe grant. A barred requester is refused here — no
  // half-effective grant, nothing to roll back.
  const minted = mintPeerToken(grant.requesterMachineId, issuedDeps);
  if (!minted.ok) return { ok: false, reason: "mint-barred" };

  // Step 2: persist the local reciprocal grant. On failure, ROLL BACK step 1
  // so no dangling issued grant survives.
  const persist = deps.persistLocalGrant ?? ((g, d) => writePeerToken(g.requesterMachineId, { baseUrl: g.peerBaseUrl, token: g.reciprocalToken }, d));
  try {
    persist(grant, peerDeps);
  } catch {
    // rollback: undo the issued half (delete, do NOT bar) and best-effort clear
    // any partial local write so neither side holds a half-effective grant.
    deleteIssuedToken(grant.requesterMachineId, issuedDeps);
    try {
      clearPeerToken(grant.requesterMachineId, peerDeps);
    } catch {
      // best-effort — the local write already failed; nothing durable landed.
    }
    return { ok: false, reason: "persist-failed" };
  }

  return { ok: true, token: minted.token, scope: "observe" };
}
