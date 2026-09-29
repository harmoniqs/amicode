// merged_projection_archived.test.ts — remote-archive parity (#1647, S1): the
// fleet projection must be able to fan out the ARCHIVED session list, not just
// the active one. buildFleetProjection gains an OPTIONAL `archived` flag; when
// set, every source is fetched with `?archived=true`, and the archived peer
// sessions come back tagged with `amicode_owner` exactly like active ones.
// Back-compat: absent/false ⇒ the existing active-only fan-out, byte-identical.
import { describe, it, expect } from "vitest";
import { buildFleetProjection, buildOwnerRoutingProjection, type SessionOwnerTag } from "../src/amicode_service/merged_projection";

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
});
