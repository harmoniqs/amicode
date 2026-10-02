// merged_projection_controlled_by.test.ts — #1568: when a remote machine holds
// an active control grant targeting the local machine, LOCAL session entries in
// the fleet projection carry an `amicode_controlled_by` overlay with the
// controlling machine's identity. Remote sessions NEVER get the overlay (they
// are owned by a peer, not by this machine). Back-compat: absent resolver ⇒ no
// field (existing callers unchanged).
import { describe, it, expect } from "vitest";
import { buildFleetProjection } from "../src/amicode_service/merged_projection";

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
    if (url.includes("/session")) {
      return new Response(JSON.stringify(byOrigin[origin]), { status: 200 });
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

const ROSTER: Record<string, { name: string }> = {
  "local-mac": { name: "MacBook Pro" },
  "peer-a": { name: "Mac Studio" },
};

describe("#1568 buildFleetProjection carries controlled_by on local sessions", () => {
  it("with resolveControlledBy, LOCAL sessions get amicode_controlled_by", async () => {
    const p = await buildFleetProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local", password: "pw" },
      peers: [{ machineId: "peer-a", getUrl: () => "http://peer-a", token: "tok-a" }],
      rosterLookup: (id: string) => ROSTER[id],
      fetchImpl: fakeFetch({
        "http://local": [{ id: "ses-local", time: { created: 1, updated: 1 } }],
        "http://peer-a": [{ id: "ses-a", time: { created: 2, updated: 2 } }],
      }),
      resolveControlledBy: () => ({ machine_id: "peer-a", machine_name: "Mac Studio" }),
    });
    const local = p.sessions.find((s) => s.id === "ses-local")!;
    expect((local as Record<string, unknown>).amicode_controlled_by).toEqual({
      machine_id: "peer-a",
      machine_name: "Mac Studio",
    });
    // Remote sessions do NOT get the overlay
    const remote = p.sessions.find((s) => s.id === "ses-a")!;
    expect((remote as Record<string, unknown>).amicode_controlled_by).toBeUndefined();
  });

  it("BACK-COMPAT: no resolveControlledBy ⇒ no amicode_controlled_by field", async () => {
    const p = await buildFleetProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local", password: "pw" },
      peers: [],
      rosterLookup: (id: string) => ROSTER[id],
      fetchImpl: fakeFetch({
        "http://local": [{ id: "ses-local", time: { created: 1, updated: 1 } }],
      }),
    });
    const local = p.sessions.find((s) => s.id === "ses-local")!;
    expect((local as Record<string, unknown>).amicode_controlled_by).toBeUndefined();
  });

  it("resolveControlledBy returns undefined ⇒ no overlay on local sessions", async () => {
    const p = await buildFleetProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local", password: "pw" },
      peers: [],
      rosterLookup: (id: string) => ROSTER[id],
      fetchImpl: fakeFetch({
        "http://local": [{ id: "ses-local", time: { created: 1, updated: 1 } }],
      }),
      resolveControlledBy: () => undefined,
    });
    const local = p.sessions.find((s) => s.id === "ses-local")!;
    expect((local as Record<string, unknown>).amicode_controlled_by).toBeUndefined();
  });
});
