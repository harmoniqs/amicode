// THE PEER-TOKEN MINT ENDPOINT HANDLER (#1438, ADR 0032 §D4).
//
// POST /amicode/fleet/peer-token?machine_id=<id>&enrollment_nonce=<nonce>
//
// The bootstrap the accept-set names (§D2): a joining machine, holding no
// standing credential, presents a single-use short-TTL enrollment nonce to
// obtain its first peer token. authorized() (server.ts) has already VALIDATED
// the nonce for this path; this handler CONSUMES it single-use and mints —
// refusing a machine_id on the mint-list bar (§D4, so a revoked machine cannot
// re-mint around `revoke`).
//
// A pure handler (no server dependency, no vscode) — the boot wiring and the
// behavioral suite both `server.add("POST", MINT_ENDPOINT_PATH, ...)` it.
import type { AmicodeHandler } from "./server";
import { consumeEnrollmentNonce, consumeBoundEnrollmentNonce } from "./fleet_enrollment_nonce";
import { mintPeerToken, revokePeerToken } from "./fleet_issued_tokens";
import { BOUND_NONCE_HEADER, BOUND_IDENTITY_HEADER } from "./fleet_bootstrap_headers";

export { MINT_ENDPOINT_PATH } from "./fleet_accept_set";
export { BOUND_NONCE_HEADER, BOUND_IDENTITY_HEADER } from "./fleet_bootstrap_headers";

/** The peer-side receiving endpoint the §D5 fan-out targets: an operator's
 *  `amico fleet revoke X` reaches every serving peer here, and each peer applies
 *  the revocation to its OWN registry (no machine writes another's). */
export const PEER_REVOKE_PATH = "/amicode/fleet/revoke";

export interface PeerTokenMintDeps {
  issuedRegistryFile?: string;
  enrollmentNonceFile?: string;
  /** The recorded-but-inert scope claim stamped on the minted token (§D6). */
  scope?: string;
}

function json(status: number, body: unknown): { status: number; body: string; contentType: string } {
  return { status, body: JSON.stringify(body), contentType: "application/json" };
}

export function peerTokenMintHandler(deps: PeerTokenMintDeps = {}): AmicodeHandler {
  return (ctx) => {
    const machineId = ctx.url.searchParams.get("machine_id")?.trim() ?? "";
    const nonce = ctx.url.searchParams.get("enrollment_nonce") ?? "";
    if (machineId === "") return json(400, { ok: false, error: "machine_id is required" });
    // Consume the nonce SINGLE-USE (authorized() only validated it). A racing
    // second request with the same nonce fails here — 401, never a second mint.
    if (!consumeEnrollmentNonce(nonce, { storeFile: deps.enrollmentNonceFile })) {
      return json(401, { ok: false, error: "enrollment nonce is invalid, expired, or already used" });
    }
    const minted = mintPeerToken(machineId, {
      registryFile: deps.issuedRegistryFile,
      ...(deps.scope !== undefined ? { scope: deps.scope } : {}),
    });
    if (!minted.ok) {
      // The mint-list bar (§D4): a revoked machine_id is refused re-minting.
      return json(403, { ok: false, error: "machine_id is barred from minting (revoked)", reason: minted.reason });
    }
    return json(200, { ok: true, machine_id: machineId, token: minted.token });
  };
}

export interface BoundPeerTokenMintDeps {
  issuedRegistryFile?: string;
  enrollmentNonceFile?: string;
  /** The recorded-but-inert scope claim stamped on the minted token (§D6).
   *  #1480 issues an OBSERVE grant; Control scope is deferred to #1486. */
  scope?: string;
  /** This machine's own machine_id — the `target` the bound nonce is bound to
   *  (the joiner enrolled WITH this machine). The handler redeems the nonce
   *  against (this target, the requesting identity_key) so a nonce minted for a
   *  different target can never mint here. */
  selfMachineId?: string;
}

/** #1480: the OFF-URL bound Observe bootstrap mint handler. The enrollment
 *  nonce and the requesting identity_key ride REQUEST HEADERS (never the URL —
 *  the #1475 audit fix); the handler CONSUMES the nonce single-use, bound to
 *  (this machine as target, the header identity_key), then mints the peer
 *  token. The consume is atomic (fleet_enrollment_nonce.ts): a replay or a
 *  concurrent second request fails here — 401, never a second mint. A missing/
 *  wrong-identity/expired nonce is a fixed-string 401 that NEVER echoes the
 *  presented nonce or the minted token (AC1). */
export function boundPeerTokenMintHandler(deps: BoundPeerTokenMintDeps = {}): AmicodeHandler {
  return (ctx) => {
    const machineId = ctx.url.searchParams.get("machine_id")?.trim() ?? "";
    if (machineId === "") return json(400, { ok: false, error: "machine_id is required" });
    const target = deps.selfMachineId?.trim() ?? "";
    if (target === "") return json(500, { ok: false, error: "target machine identity is not configured" });
    const hdr = (name: string): string => {
      const raw = ctx.headers?.[name.toLowerCase()];
      const v = Array.isArray(raw) ? raw[0] : raw;
      return typeof v === "string" ? v.trim() : "";
    };
    const nonce = hdr(BOUND_NONCE_HEADER);
    const identityKey = hdr(BOUND_IDENTITY_HEADER);
    // Consume the bound nonce SINGLE-USE, atomically (authorized() only
    // validated it). A racing second request, a replay, or a wrong identity
    // fails here — 401, never a second mint, and the failure NEVER echoes the
    // nonce (AC1: no secret in any error string).
    if (nonce === "" || identityKey === "" || !consumeBoundEnrollmentNonce(nonce, { target, identityKey }, { storeFile: deps.enrollmentNonceFile })) {
      return json(401, { ok: false, error: "bound enrollment nonce is invalid, expired, wrong-identity, or already used" });
    }
    const minted = mintPeerToken(machineId, {
      registryFile: deps.issuedRegistryFile,
      // #1480 issues an OBSERVE grant; Control scope is deferred to #1486.
      scope: deps.scope ?? "observe",
    });
    if (!minted.ok) {
      // The mint-list bar (§D4): a revoked machine_id is refused re-minting.
      return json(403, { ok: false, error: "machine_id is barred from minting (revoked)", reason: minted.reason });
    }
    return json(200, { ok: true, machine_id: machineId, token: minted.token, scope: "observe" });
  };
}

export interface PeerRevokeDeps {
  issuedRegistryFile?: string;
}

/** The receiving side of `amico fleet revoke <machine_id>` (§D5): drop the
 *  peer's issued grant AND add it to the mint-list bar, on THIS machine's own
 *  registry. Idempotent — revoking an unknown machine_id still bars it. The
 *  caller is authenticated by the accept-set (a local mint or peer token). */
export function peerRevokeHandler(deps: PeerRevokeDeps = {}): AmicodeHandler {
  return (ctx) => {
    const machineId = ctx.url.searchParams.get("machine_id")?.trim() ?? "";
    if (machineId === "") return json(400, { ok: false, error: "machine_id is required" });
    revokePeerToken(machineId, { registryFile: deps.issuedRegistryFile });
    return json(200, { ok: true, machine_id: machineId, revoked: true });
  };
}
