// merged_projection_local_open_engine.test.ts — the fleet Sessions surface
// (GET /amicode/fleet/sessions) is CROSS-PROJECT by design (it fans
// /experimental/session out to every source). On an observation-only machine
// the local engine is an OPEN loopback (no per-boot Basic password is threaded
// to the projection's local source), yet the projection bailed on the missing
// credential with `present:false, "engine mint not armed"` and contributed ZERO
// local sessions — so a machine could not see its OWN sessions in its fleet
// dropdown (the MacBook got away with it by reading the peer; the owning peer,
// whose sessions are LOCAL, showed nothing). The local loopback source must be
// read WITHOUT auth when no password is configured — the engine is open, exactly
// as the EngineProxy already assumes when it dials it credential-less.
import { describe, it, expect } from "vitest";
import { buildFleetProjection } from "../src/amicode_service/merged_projection";

/** An OPEN engine stub: serves its session array + /global/health to ANY
 *  caller, with or without an Authorization header (the real loopback engine
 *  binds localhost and does not require auth). */
function openEngineFetch(byOrigin: Record<string, Array<Record<string, unknown>>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const origin = Object.keys(byOrigin).find((o) => url.startsWith(o));
    if (!origin) return new Response("no", { status: 502 });
    if (url.endsWith("/global/health")) return new Response(JSON.stringify({ version: "open-1" }), { status: 200 });
    if (url.includes("/session")) return new Response(JSON.stringify(byOrigin[origin]), { status: 200 });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("fleet projection — the local loopback source is read WITHOUT a password (open engine)", () => {
  it("a local source with NO password still contributes its sessions (not 'engine mint not armed')", async () => {
    const projection = await buildFleetProjection({
      localMachineId: "jjs-mac-studio",
      // NO password — the observation-only path passes engine.password === undefined.
      local: { getUrl: () => "http://local-engine" },
      peers: [],
      rosterLookup: () => undefined,
      fetchImpl: openEngineFetch({
        "http://local-engine": [
          { id: "ses-studio-1", time: { created: 10, updated: 10 } },
          { id: "ses-studio-2", time: { created: 20, updated: 20 } },
        ],
      }),
    });

    // the local source is PRESENT (it read the open engine), not credential-missing
    const localSource = projection.sources["jjs-mac-studio"];
    expect(localSource.present).toBe(true);
    // and the machine's OWN sessions appear in the cross-project projection
    const ids = projection.sessions.map((s) => s.id);
    expect(ids).toContain("ses-studio-1");
    expect(ids).toContain("ses-studio-2");
  });

  it("a local source WITH a password still authenticates as before (back-compat)", async () => {
    // The engine here requires auth: it 401s a credential-less call. With a
    // password the projection must still authenticate and read the sessions.
    const authedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const hasAuth = !!(init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (url.endsWith("/global/health")) return new Response(JSON.stringify({ version: "authed-1" }), { status: 200 });
      if (url.includes("/session")) {
        if (!hasAuth) return new Response("nope", { status: 401 });
        return new Response(JSON.stringify([{ id: "ses-authed", time: { created: 1, updated: 1 } }]), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;

    const projection = await buildFleetProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local-engine", password: "pw" },
      peers: [],
      rosterLookup: () => undefined,
      fetchImpl: authedFetch,
    });
    expect(projection.sources["local-mac"].present).toBe(true);
    expect(projection.sessions.map((s) => s.id)).toContain("ses-authed");
  });
});
