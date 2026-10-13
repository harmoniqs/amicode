// peer_home_base_fetch.test.ts — #1643 remote-create unblock (S8): the live
// server-side peer read that resolves a peer's home-base by fetching its OWN
// /amicode/fleet/peer-workspace route (the "live peer read" design decision).
// This replaces the readPeerHomeDir stub: the local peer-home-base route calls
// this, which dials the peer's transport (reader token) and reads home_base.
import { describe, it, expect } from "vitest";
import { fetchPeerHomeBase, type PeerFetchDeps } from "../src/amicode_service/peer_home_base_fetch";

function deps(over?: Partial<PeerFetchDeps>): PeerFetchDeps {
  return {
    resolvePeer: (id) =>
      id === "studio" ? { baseUrl: "http://studio.local:45096", token: "tok" } : undefined,
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, home_base: "/Users/studio/amico-projects", projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ...over,
  };
}

describe("#1643 fetchPeerHomeBase — live peer read of /amicode/fleet/peer-workspace", () => {
  it("dials the peer's transport and returns its home_base", async () => {
    let calledUrl = "";
    let auth = "";
    const dir = await fetchPeerHomeBase("studio", deps({
      fetchImpl: async (url, init) => {
        calledUrl = String(url);
        auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response(JSON.stringify({ ok: true, home_base: "/w", projects: [] }), { status: 200 });
      },
    }));
    expect(dir).toBe("/w");
    expect(calledUrl).toContain("/amicode/fleet/peer-workspace");
    expect(calledUrl.startsWith("http://studio.local:45096")).toBe(true);
    expect(auth).toBeTruthy(); // peer auth header attached
  });

  it("an unknown/unresolvable peer → undefined (→ no-remote-root)", async () => {
    const dir = await fetchPeerHomeBase("ghost", deps());
    expect(dir).toBeUndefined();
  });

  it("a peer whose workspace omits home_base → undefined", async () => {
    const dir = await fetchPeerHomeBase("studio", deps({
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, projects: [] }), { status: 200 }),
    }));
    expect(dir).toBeUndefined();
  });

  it("a non-200 from the peer → undefined (never a fabricated dir)", async () => {
    const dir = await fetchPeerHomeBase("studio", deps({
      fetchImpl: async () => new Response("nope", { status: 503 }),
    }));
    expect(dir).toBeUndefined();
  });

  it("a fetch that throws → undefined (honest, never throws to the route)", async () => {
    const dir = await fetchPeerHomeBase("studio", deps({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }));
    expect(dir).toBeUndefined();
  });

  it("malformed JSON from the peer → undefined", async () => {
    const dir = await fetchPeerHomeBase("studio", deps({
      fetchImpl: async () => new Response("{not json", { status: 200 }),
    }));
    expect(dir).toBeUndefined();
  });
});
