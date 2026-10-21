// merged_projection_archived.test.ts — remote-archive parity (#1647, S1): the
// fleet projection must be able to fan out the ARCHIVED session list, not just
// the active one. buildFleetProjection gains an OPTIONAL `archived` flag; when
// set, every source is fetched with `?archived=true`, and the archived peer
// sessions come back tagged with `amicode_owner` exactly like active ones.
// Back-compat: absent/false ⇒ the existing active-only fan-out, byte-identical.
import { describe, it, expect } from "vitest";
import { buildFleetProjection, buildOwnerRoutingProjection, type SessionOwnerTag } from "../src/amicode_service/merged_projection";
import { buildControlResolver } from "../src/amicode_service/remote_session_state";

/** A fetch stub that records every URL it is asked for and serves DIFFERENT
 *  session sets for the active vs archived query (keyed on `archived=true`). */
function recordingFetch(
  active: Record<string, Array<Record<string, unknown>>>,
  archived: Record<string, Array<Record<string, unknown>>>,
  seen: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    const origin = Object.keys(active).find((o) => url.startsWith(o));
    if (!origin) return new Response("no", { status: 502 });
    if (url.endsWith("/global/health")) {
      return new Response(JSON.stringify({ version: "test-1" }), { status: 200 });
    }
    if (url.includes("/session")) {
      const isArchived = /[?&]archived=true\b/.test(url);
      const set = isArchived ? (archived[origin] ?? []) : (active[origin] ?? []);
      return new Response(JSON.stringify(set), { status: 200 });
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}

const ROSTER: Record<string, { name: string }> = {
  "local-mac": { name: "MacBook Pro" },
  "peer-a": { name: "Mac Studio" },
};

function opts(archived: boolean, seen: string[]) {
  return {
    localMachineId: "local-mac",
    local: { getUrl: () => "http://local", password: "pw" },
    peers: [{ machineId: "peer-a", getUrl: () => "http://peer-a", token: "tok-a" }],
    rosterLookup: (id: string) => ROSTER[id],
    fetchImpl: recordingFetch(
      {
        "http://local": [{ id: "ses-local-active", time: { created: 1, updated: 1 } }],
        "http://peer-a": [{ id: "ses-a-active", time: { created: 2, updated: 2 } }],
      },
      {
        "http://local": [{ id: "ses-local-arch", time: { created: 10, updated: 10, archived: 10 } }],
        "http://peer-a": [{ id: "ses-a-arch", time: { created: 20, updated: 20, archived: 20 } }],
      },
      seen,
    ),
    ...(archived ? { archived: true } : {}),
  };
}

describe("#1647 S1 — buildFleetProjection can fan out the ARCHIVED list", () => {
  it("BACK-COMPAT: archived unset ⇒ active-only fan-out, no ?archived=true", async () => {
    const seen: string[] = [];
    const p = await buildFleetProjection(opts(false, seen));
    // fetched the active sessions from both sources
    expect(p.sessions.map((s) => s.id).sort()).toEqual(["ses-a-active", "ses-local-active"]);
    // no source URL asked for archived
    expect(seen.some((u) => /archived=true/.test(u))).toBe(false);
  });

  it("archived:true ⇒ every source fetched with ?archived=true, archived sessions returned", async () => {
    const seen: string[] = [];
    const p = await buildFleetProjection(opts(true, seen));
    // the merged projection now carries the ARCHIVED sessions
    expect(p.sessions.map((s) => s.id).sort()).toEqual(["ses-a-arch", "ses-local-arch"]);
    // both the local AND the peer session-list fetch carried the archived flag
    const sessionFetches = seen.filter((u) => u.includes("/session") && !u.endsWith("/global/health"));
    expect(sessionFetches.length).toBeGreaterThanOrEqual(2);
    expect(sessionFetches.every((u) => /archived=true/.test(u))).toBe(true);
  });

  it("archived peer sessions are owner-tagged just like active ones", async () => {
    const seen: string[] = [];
    const p = await buildFleetProjection(opts(true, seen));
    const a = p.sessions.find((s) => s.id === "ses-a-arch")!;
    expect((a.amicode_owner as SessionOwnerTag).owner_machine_id).toBe("peer-a");
    expect((a.amicode_owner as SessionOwnerTag).is_local).toBe(false);
    const local = p.sessions.find((s) => s.id === "ses-local-arch")!;
    expect((local.amicode_owner as SessionOwnerTag).is_local).toBe(true);
  });
});

describe("#1647 S2 — buildOwnerRoutingProjection unions active + archived for write-routing", () => {
  it("owner map source includes BOTH active and archived peer sessions (owner-tagged)", async () => {
    const seen: string[] = [];
    // buildOwnerRoutingProjection takes the same opts sans `archived` — it runs
    // both variants internally so unarchive/delete of an ARCHIVED remote row is
    // routable (its id resolves to the owner machine, not silently local).
    const { archived: _drop, ...base } = opts(false, seen) as ReturnType<typeof opts> & { archived?: boolean };
    const p = await buildOwnerRoutingProjection(base);
    const ids = p.sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["ses-a-active", "ses-a-arch", "ses-local-active", "ses-local-arch"]);
    const arch = p.sessions.find((s) => s.id === "ses-a-arch")!;
    expect((arch.amicode_owner as SessionOwnerTag).owner_machine_id).toBe("peer-a");
    // it fetched both the active AND the archived list from each source
    const sessionFetches = seen.filter((u) => u.includes("/session") && !u.endsWith("/global/health"));
    expect(sessionFetches.some((u) => /archived=true/.test(u))).toBe(true);
    expect(sessionFetches.some((u) => !/archived=true/.test(u))).toBe(true);
  });

  it("#1647 S8: the union carries amicode_control on ARCHIVED sessions (tab icon survives archive)", async () => {
    // The `?scope=all` route (tab driving-indicator + composer scrim source)
    // uses this union with a control resolver. An OPEN-but-archived REMOTE
    // session must keep BOTH its owner and control overlays, or its tab monitor
    // icon vanishes on archive — the bug this locks down.
    const seen: string[] = [];
    const { archived: _drop, ...base } = opts(false, seen) as ReturnType<typeof opts> & { archived?: boolean };
    const resolveControl = buildControlResolver({
      localMachineId: "local-mac",
      grantReader: (id) => (id === "peer-a" ? { scope: "control", state: "active" } : undefined),
      peerReachable: (id) => id === "peer-a",
      isSelfOwned: () => true,
    });
    const p = await buildOwnerRoutingProjection({ ...base, resolveControl });
    const arch = p.sessions.find((s) => s.id === "ses-a-arch")! as Record<string, unknown>;
    expect((arch.amicode_owner as SessionOwnerTag).owner_machine_id).toBe("peer-a");
    // control overlay present on the ARCHIVED remote session → drivingBanner resolves
    expect(arch.amicode_control).toEqual({ controlState: "interactive", reason: null, eligibility: "none" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1771 — the owner-routing projection reports EACH PEER's refresh outcome (the
// OwnerMapFeed logs it). Never throws: every failure is a classified record.
// The served projection shape is unchanged — this rides only the routing union.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1771 — buildOwnerRoutingProjection classifies each peer's refresh", () => {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

  it("ok / unauthorized / timeout / error — with each peer's entry count (active ∪ archived)", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/global/health")) return json({ version: "t" });
      if (url.startsWith("http://ok")) return json(/archived=true/.test(url) ? [{ id: "ses-ok-arch" }] : [{ id: "ses-ok-1" }]);
      if (url.startsWith("http://denied")) return new Response("no", { status: 401 });
      if (url.startsWith("http://broken")) return new Response("bad gateway", { status: 502 });
      if (url.startsWith("http://slow")) {
        // a peer that never answers: the projection's own AbortSignal.timeout fires
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      return json([]); // local
    }) as unknown as typeof fetch;
    const p = await buildOwnerRoutingProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local" },
      peers: [
        { machineId: "ok", getUrl: () => "http://ok", token: "t" },
        { machineId: "denied", getUrl: () => "http://denied", token: "t" },
        { machineId: "slow", getUrl: () => "http://slow", token: "t" },
        { machineId: "broken", getUrl: () => "http://broken", token: "t" },
        { machineId: "gone", getUrl: () => undefined, token: "t" },
      ],
      rosterLookup: () => undefined,
      fetchImpl,
      timeoutMs: 1,
    });
    const summary = p.peers.map(({ machineId, outcome, entries, reason, detail }) => ({ machineId, outcome, entries, reason, detail }));
    expect(summary).toEqual([
      { machineId: "ok", outcome: "ok", entries: 2, reason: undefined, detail: undefined },
      { machineId: "denied", outcome: "unauthorized", entries: 0, reason: "unauthorized", detail: undefined },
      { machineId: "slow", outcome: "timeout", entries: 0, reason: "fetch-failed", detail: expect.stringContaining("timeout") },
      { machineId: "broken", outcome: "error", entries: 0, reason: "fetch-failed", detail: "HTTP 502" },
      { machineId: "gone", outcome: "error", entries: 0, reason: "no-upstream", detail: undefined },
    ]);
    // the routing union itself is unchanged: only the healthy peer's sessions land
    expect(p.sessions.map((s) => s.id).sort()).toEqual(["ses-ok-1", "ses-ok-arch"]);
  });

  it("each peer's duration is measured on the injected clock", async () => {
    let t = 1_000;
    const held: Array<() => void> = [];
    // plain promise-backed responses: every read is a microtask, nothing waits
    // on a stream or a timer
    const fake = (v: unknown) => ({ ok: true, status: 200, json: async () => v }) as unknown as Response;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/global/health")) return fake({ version: "t" });
      if (url.startsWith("http://slowish")) return new Promise<Response>((resolve) => held.push(() => resolve(fake([{ id: "ses-s" }]))));
      return fake([]);
    }) as unknown as typeof fetch;
    const pending = buildOwnerRoutingProjection({
      localMachineId: "local-mac",
      local: { getUrl: () => "http://local" },
      peers: [
        { machineId: "quick", getUrl: () => "http://quick", token: "t" },
        { machineId: "slowish", getUrl: () => "http://slowish", token: "t" },
      ],
      rosterLookup: () => undefined,
      fetchImpl,
      now: () => t,
    });
    // Every fetch but the held ones resolves at once, so one macrotask turn
    // drains them all (microtasks only) — the quick peer is done, the slow
    // peer's two reads (active + archived) are in flight.
    await new Promise<void>((r) => setImmediate(r));
    expect(held).toHaveLength(2);
    t = 2_500; // 1.5 s pass while the slow peer answers
    held.forEach((release) => release());
    const p = await pending;
    expect(p.peers.find((r) => r.machineId === "quick")).toMatchObject({ outcome: "ok", durationMs: 0, entries: 0 });
    expect(p.peers.find((r) => r.machineId === "slowish")).toMatchObject({ outcome: "ok", durationMs: 1_500, entries: 1 });
  });
});
