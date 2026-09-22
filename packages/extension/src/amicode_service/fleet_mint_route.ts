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
import { consumeEnrollmentNonce } from "./fleet_enrollment_nonce";
import { mintPeerToken } from "./fleet_issued_tokens";

export { MINT_ENDPOINT_PATH } from "./fleet_accept_set";

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
