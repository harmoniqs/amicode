// merged_projection_control.test.ts — #1544 (slice 4): the state channel is
// CARRIED on the fleet projection (GET /amicode/fleet/sessions). buildFleetProjection
// gains an OPTIONAL `resolveControl` injector that stamps the app-visible
// `amicode_control` overlay (the { controlState, reason, eligibility } shape,
// projected from the SoT remote_session_state) beside each entry's `amicode_owner`.
// Back-compat: absent resolver ⇒ NO field (existing callers unchanged).
import { describe, it, expect } from "vitest";
import { buildFleetProjection, type SessionOwnerTag } from "../src/amicode_service/merged_projection";
import { buildControlResolver, type SessionControlProjection } from "../src/amicode_service/remote_session_state";

/** A fetch stub: every origin serves its own session array + a /global/health
 *  version stamp. Keyed by origin URL. */
function fakeFetch(byOrigin: Record<string, Array<Record<string, unknown>>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const origin = Object.keys(byOrigin).find((o) => url.startsWith(o));
    if (!origin) return new Response("no", { status: 502 });
    if (url.endsWith("/global/health")) {
      return new Response(JSON.stringify({ version: "test-1" }), { status: 200 });
    }
    if (url.endsWith("/session")) {
      return new Response(JSON.stringify(byOrigin[origin]), { status: 200 });
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

const ROSTER: Record<string, { name: string }> = {
  "local-mac": { name: "MacBook Pro" },
  "peer-a": { name: "Mac Studio" },
  "peer-b": { name: "Mac Mini" },
};

function opts(resolveControl?: (ownerMachineId: string, isLocal: boolean) => SessionControlProjection) {
  return {
    localMachineId: "local-mac",
    local: { getUrl: () => "http://local", password: "pw" },
    peers: [
      { machineId: "peer-a", getUrl: () => "http://peer-a", token: "tok-a" },
      { machineId: "peer-b", getUrl: () => "http://peer-b", token: "tok-b" },
    ],
    rosterLookup: (id: string) => ROSTER[id],
    fetchImpl: fakeFetch({
      "http://local": [{ id: "ses-local", time: { created: 1, updated: 1 } }],
      "http://peer-a": [{ id: "ses-a", time: { created: 2, updated: 2 } }],
      "http://peer-b": [{ id: "ses-b", time: { created: 3, updated: 3 } }],
    }),
    ...(resolveControl ? { resolveControl } : {}),
  };
}

describe("#1544 buildFleetProjection carries the control channel (amicode_control)", () => {
  it("BACK-COMPAT: no resolveControl ⇒ entries carry amicode_owner but NO amicode_control", async () => {
    const p = await buildFleetProjection(opts());
    const a = p.sessions.find((s) => s.id === "ses-a")!;
    expect((a.amicode_owner as SessionOwnerTag).owner_machine_id).toBe("peer-a");
    expect((a as Record<string, unknown>).amicode_control).toBeUndefined();
  });

  it("with a resolver, each entry gets amicode_control derived from its owner (SoT projection)", async () => {
    const resolveControl = buildControlResolver({
      localMachineId: "local-mac",
      // peer-a has an active control grant; peer-b has none
      grantReader: (id) => (id === "peer-a" ? { scope: "control", state: "active" } : undefined),
      peerReachable: (id) => id === "peer-a",
      isSelfOwned: () => true,
    });
    const p = await buildFleetProjection(opts(resolveControl));

    const local = p.sessions.find((s) => s.id === "ses-local")! as Record<string, unknown>;
    expect(local.amicode_control).toEqual({ controlState: "local", reason: null, eligibility: "none" });

    const a = p.sessions.find((s) => s.id === "ses-a")! as Record<string, unknown>;
    expect(a.amicode_control).toEqual({ controlState: "interactive", reason: null, eligibility: "none" });

    const b = p.sessions.find((s) => s.id === "ses-b")! as Record<string, unknown>;
    expect(b.amicode_control).toEqual({
      controlState: "read-only",
      reason: "no-control-grant",
      eligibility: "enable-control",
    });
  });

  it("a revocation-pending peer stays DISTINCT (suspended/revocation-pending) through the carrier", async () => {
    const resolveControl = buildControlResolver({
      localMachineId: "local-mac",
      grantReader: (id) => (id === "peer-a" ? { scope: "control", state: "revocation-pending" } : undefined),
      peerReachable: () => true,
      isSelfOwned: () => true,
    });
    const p = await buildFleetProjection(opts(resolveControl));
    const a = p.sessions.find((s) => s.id === "ses-a")! as Record<string, unknown>;
    expect(a.amicode_control).toEqual({
      controlState: "suspended",
      reason: "revocation-pending",
      eligibility: "enable-control",
    });
  });
});
