// fleet_session_status.test.ts — #1766 checkpoint 2: the fleet-wide session
// status read's two halves, with an INJECTED fetch (the fleet projection suites'
// style — no real network):
//   - RESOLUTION: requested ids + the live owner map → a per-(owner, directory)
//     query plan + the unresolved list (unknown / no-directory / over-cap);
//   - FAN-OUT: plan → each owner's `/session/status?directory=<d>` exactly once
//     per distinct directory → one VALIDATED tri-state map + per-source /
//     per-directory records (idle by absence; honest omission on any failure).
import { describe, it, expect } from "vitest";
import { SessionOwnerMap, type SessionEntry } from "../src/amicode_service/session_multiplexer";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
import { serverAuthHeader } from "../src/server_auth";
import {
  readFleetSessionStatus,
  planFleetSessionStatus,
  parseStatusIds,
  FLEET_STATUS_MAX_IDS,
  FLEET_STATUS_MAX_QUERIES,
  FLEET_STATUS_DEADLINE_MS,
  FLEET_STATUS_QUERY_TIMEOUT_MS,
  type FleetStatusSourceOptions,
} from "../src/amicode_service/fleet_session_status";

// ── fixtures ─────────────────────────────────────────────────────────────────

const LOCAL = "macbook";
const STUDIO = "studio";
const LOCAL_ORIGIN = "http://local.test";
const STUDIO_ORIGIN = "http://studio.test";

function ownerMapOf(rows: Array<[id: string, owner: string, directory?: string]>): SessionOwnerMap {
  const m = new SessionOwnerMap();
  m.update(
    rows.map(
      ([id, owner, directory]): SessionEntry => ({
        id,
        ...(directory !== undefined ? { directory } : {}),
        amicode_owner: { owner_machine_id: owner, owner_name: owner, is_local: owner === LOCAL },
      }),
    ),
  );
  return m;
}

/** The two-source topology: the local engine (engine password armed) + one
 *  trusted, reachable peer with its own reader token. */
function sources(over: Partial<FleetStatusSourceOptions> = {}): FleetStatusSourceOptions {
  return {
    localMachineId: LOCAL,
    local: { getUrl: () => LOCAL_ORIGIN, password: "engine-pw" },
    peers: [{ machineId: STUDIO, getUrl: () => STUDIO_ORIGIN, token: "tok-studio" }],
    ...over,
  };
}

type Reply =
  | { status?: number; body?: unknown; raw?: string }
  | "network-error"
  | "hang" // never settles, ignores the abort signal
  | "hang-abortable"; // never settles on its own, rejects on abort

interface Call {
  origin: string;
  path: string;
  directory: string | null;
  auth: string | undefined;
}

/** An injected fetch answering per `${origin}|${directory}`. Unrouted → 404. */
function fakeFetch(replies: Record<string, Reply>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const directory = u.searchParams.get("directory");
    calls.push({ origin: u.origin, path: u.pathname, directory, auth: headers.Authorization });
    const reply = replies[`${u.origin}|${directory}`];
    if (reply === undefined) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    if (reply === "network-error") throw new TypeError("fetch failed: ECONNREFUSED");
    if (reply === "hang") return new Promise<Response>(() => {});
    if (reply === "hang-abortable") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
      });
    }
    const text = reply.raw ?? JSON.stringify(reply.body === undefined ? {} : reply.body);
    const status = reply.status ?? 200;
    // null-body statuses (204/205/304) cannot carry a body in a Response
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const key = (origin: string, directory: string) => `${origin}|${directory}`;

// ══════════════════════════════════════════════════════════════════════════════
// AC — fan-out by owner and directory
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — fan-out by owner and directory", () => {
  it("queries each owner exactly once per distinct directory (verbatim), and returns a status for every requested session in a queried directory", async () => {
    const ownerMap = ownerMapOf([
      ["ses-L1", LOCAL, "/work/a"],
      ["ses-L2", LOCAL, "/work/a"],
      ["ses-L3", LOCAL, "/work/b/"],
      ["ses-P1", STUDIO, "/Users/jj/proj"],
      ["ses-P2", STUDIO, "/Users/jj/other dir"],
    ]);
    const { fetchImpl, calls } = fakeFetch({
      [key(LOCAL_ORIGIN, "/work/a")]: { body: { "ses-L1": { type: "busy" } } },
      [key(LOCAL_ORIGIN, "/work/b/")]: { body: {} },
      [key(STUDIO_ORIGIN, "/Users/jj/proj")]: { body: { "ses-P1": { type: "busy" }, "ses-not-asked": { type: "busy" } } },
      [key(STUDIO_ORIGIN, "/Users/jj/other dir")]: {
        body: { "ses-P2": { type: "retry", attempt: 2, message: "rate limited", next: 1700000000000 } },
      },
    });

    const res = await readFleetSessionStatus("ses-L1,ses-P1,ses-L2,ses-L3,ses-P2", {
      ownerMap,
      sources: sources(),
      fetchImpl,
    });

    // exactly one query per (owner, directory), the directory byte-for-byte
    expect(calls.map((c) => `${c.origin}|${c.directory}`).sort()).toEqual(
      [
        key(LOCAL_ORIGIN, "/work/a"),
        key(LOCAL_ORIGIN, "/work/b/"),
        key(STUDIO_ORIGIN, "/Users/jj/proj"),
        key(STUDIO_ORIGIN, "/Users/jj/other dir"),
      ].sort(),
    );
    expect(calls.every((c) => c.path === "/session/status")).toBe(true);
    // each source is reached as the fleet projection reaches it — never the hub credential
    for (const c of calls) {
      expect(c.auth).toBe(c.origin === LOCAL_ORIGIN ? serverAuthHeader("engine-pw") : peerAuthHeader("tok-studio"));
    }
    // a status for EVERY requested session; an un-requested entry never leaks in
    expect(res.statuses).toEqual({
      "ses-L1": { type: "busy" },
      "ses-L2": { type: "idle" },
      "ses-L3": { type: "idle" },
      "ses-P1": { type: "busy" },
      "ses-P2": { type: "retry", attempt: 2, message: "rate limited", next: 1700000000000 },
    });
    expect(res.unresolved).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.sources[LOCAL]).toEqual({
      present: true,
      directories: { "/work/a": { ok: true, sessions: 2 }, "/work/b/": { ok: true, sessions: 1 } },
    });
    expect(res.sources[STUDIO]).toEqual({
      present: true,
      directories: { "/Users/jj/proj": { ok: true, sessions: 1 }, "/Users/jj/other dir": { ok: true, sessions: 1 } },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — idle by absence
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — idle by absence", () => {
  it("a requested session absent from its own (owner, directory)'s successful answer is EXACTLY {type:'idle'} — never omitted", async () => {
    const ownerMap = ownerMapOf([["ses-quiet", STUDIO, "/p"]]);
    const { fetchImpl } = fakeFetch({ [key(STUDIO_ORIGIN, "/p")]: { body: {} } });
    const res = await readFleetSessionStatus("ses-quiet", { ownerMap, sources: sources(), fetchImpl });
    expect(Object.keys(res.statuses)).toEqual(["ses-quiet"]);
    expect(res.statuses["ses-quiet"]).toStrictEqual({ type: "idle" });
    expect(res.unresolved).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — honest absence per directory
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — honest absence per directory", () => {
  it.each([
    {
      name: "unreachable (no URL)",
      peer: { machineId: STUDIO, getUrl: () => undefined, token: "tok-studio" },
      reason: "no-upstream",
    },
    {
      name: "untrusted (no Observe grant)",
      peer: { machineId: STUDIO, getUrl: () => STUDIO_ORIGIN, token: "tok-studio", trusted: false },
      reason: "untrusted",
    },
    {
      name: "no usable credential",
      peer: { machineId: STUDIO, getUrl: () => STUDIO_ORIGIN, token: undefined },
      reason: "credential-missing",
    },
  ])("an owner that is $name is never contacted; its sessions are OMITTED and every directory names $reason", async ({ peer, reason }) => {
    const ownerMap = ownerMapOf([
      ["ses-P1", STUDIO, "/p1"],
      ["ses-P2", STUDIO, "/p2"],
      ["ses-P3", STUDIO, "/p2"],
    ]);
    const { fetchImpl, calls } = fakeFetch({
      [key(STUDIO_ORIGIN, "/p1")]: { body: {} },
      [key(STUDIO_ORIGIN, "/p2")]: { body: {} },
    });
    const res = await readFleetSessionStatus("ses-P1,ses-P2,ses-P3", {
      ownerMap,
      sources: sources({ peers: [peer] }),
      fetchImpl,
    });
    expect(calls).toEqual([]); // never contacted
    expect(res.statuses).toEqual({}); // never reported idle
    expect(res.sources[STUDIO]).toEqual({
      present: false,
      reason,
      directories: {
        "/p1": { ok: false, reason, sessions: 1 },
        "/p2": { ok: false, reason, sessions: 2 },
      },
    });
  });

  it("a blocked (identity-conflict) owner is NAMED, never contacted, its sessions omitted", async () => {
    const ownerMap = ownerMapOf([["ses-P1", STUDIO, "/p1"]]);
    const { fetchImpl, calls } = fakeFetch({ [key(STUDIO_ORIGIN, "/p1")]: { body: {} } });
    const res = await readFleetSessionStatus("ses-P1", {
      ownerMap,
      sources: sources({ blockedPeers: [{ machineId: STUDIO }] }),
      fetchImpl,
    });
    expect(calls).toEqual([]);
    expect(res.statuses).toEqual({});
    expect(res.sources[STUDIO]).toMatchObject({ present: false, reason: "identity-conflict" });
    expect(res.sources[STUDIO].directories["/p1"]).toEqual({ ok: false, reason: "identity-conflict", sessions: 1 });
  });

  it("an owner that is not a serving peer at all is no-upstream (never routed anywhere else)", async () => {
    const ownerMap = ownerMapOf([["ses-X", "gone-machine", "/x"]]);
    const { fetchImpl, calls } = fakeFetch({});
    const res = await readFleetSessionStatus("ses-X", { ownerMap, sources: sources(), fetchImpl });
    expect(calls).toEqual([]);
    expect(res.statuses).toEqual({});
    expect(res.sources["gone-machine"]).toEqual({
      present: false,
      reason: "no-upstream",
      directories: { "/x": { ok: false, reason: "no-upstream", sessions: 1 } },
    });
  });

  it.each([
    { name: "401", reply: { status: 401, body: { ok: false } }, reason: "unauthorized", detail: undefined },
    { name: "403", reply: { status: 403, body: { ok: false } }, reason: "unauthorized", detail: undefined },
    { name: "500", reply: { status: 500, body: { message: "boom" } }, reason: "fetch-failed", detail: "HTTP 500" },
    { name: "204 (not a 200)", reply: { status: 204, raw: "" }, reason: "fetch-failed", detail: "HTTP 204" },
    { name: "a non-JSON 200", reply: { status: 200, raw: "<html>proxy error</html>" }, reason: "fetch-failed", detail: undefined },
    { name: "a network error", reply: "network-error" as const, reason: "fetch-failed", detail: undefined },
  ])("a directory whose query fails ($name) omits ITS sessions and names $reason — the same owner's other directory still answers", async ({ reply, reason, detail }) => {
    const ownerMap = ownerMapOf([
      ["ses-good", STUDIO, "/good"],
      ["ses-bad", STUDIO, "/bad"],
    ]);
    const { fetchImpl } = fakeFetch({
      [key(STUDIO_ORIGIN, "/good")]: { body: { "ses-good": { type: "busy" } } },
      [key(STUDIO_ORIGIN, "/bad")]: reply,
    });
    const res = await readFleetSessionStatus("ses-good,ses-bad", { ownerMap, sources: sources(), fetchImpl });
    expect(res.statuses).toEqual({ "ses-good": { type: "busy" } }); // ses-bad omitted, NOT idle
    expect(res.sources[STUDIO].present).toBe(true);
    expect(res.sources[STUDIO].directories["/good"]).toEqual({ ok: true, sessions: 1 });
    expect(res.sources[STUDIO].directories["/bad"]).toMatchObject({ ok: false, reason, sessions: 1 });
    if (detail !== undefined) expect(res.sources[STUDIO].directories["/bad"].detail).toBe(detail);
  });

  it("a failed LOCAL directory does not affect the peer's answer (per-(owner, directory) isolation)", async () => {
    const ownerMap = ownerMapOf([
      ["ses-L", LOCAL, "/l"],
      ["ses-P", STUDIO, "/p"],
    ]);
    const { fetchImpl } = fakeFetch({
      [key(LOCAL_ORIGIN, "/l")]: "network-error",
      [key(STUDIO_ORIGIN, "/p")]: { body: { "ses-P": { type: "busy" } } },
    });
    const res = await readFleetSessionStatus("ses-L,ses-P", { ownerMap, sources: sources(), fetchImpl });
    expect(res.statuses).toEqual({ "ses-P": { type: "busy" } });
    expect(res.sources[LOCAL].directories["/l"]).toMatchObject({ ok: false, reason: "fetch-failed" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — unknown sessions (resolution half)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — unknown sessions", () => {
  it("an id the owner map does not know is omitted and listed `unknown`; an owned id with no directory is never queried and listed `no-directory`", async () => {
    const ownerMap = ownerMapOf([
      ["ses-known", STUDIO, "/p"],
      ["ses-nodir", STUDIO], // owned, but the projection carried no directory
    ]);
    ownerMap.recordPendingOwner("ses-pending", STUDIO); // a create-time binding: owner, no directory
    const { fetchImpl, calls } = fakeFetch({ [key(STUDIO_ORIGIN, "/p")]: { body: {} } });
    const res = await readFleetSessionStatus("ses-ghost,ses-known,ses-nodir,ses-pending", {
      ownerMap,
      sources: sources(),
      fetchImpl,
    });
    expect(res.statuses).toEqual({ "ses-known": { type: "idle" } });
    expect(res.unresolved).toEqual([
      { id: "ses-ghost", reason: "unknown" },
      { id: "ses-nodir", reason: "no-directory" },
      { id: "ses-pending", reason: "no-directory" },
    ]);
    // the read never queries a directory that did not come from the owner map
    expect(calls.map((c) => c.directory)).toEqual(["/p"]);
  });

  it("the resolution half alone: ids → per-(owner, directory) plan in request order + unresolved", () => {
    const ownerMap = ownerMapOf([
      ["a", STUDIO, "/p"],
      ["b", LOCAL, "/l"],
      ["c", STUDIO, "/p"],
      ["d", STUDIO, "/q"],
    ]);
    const plan = planFleetSessionStatus(["a", "b", "zz", "c", "d"], ownerMap);
    expect(plan.queries).toEqual([
      { owner: STUDIO, directory: "/p", sessionIds: ["a", "c"] },
      { owner: LOCAL, directory: "/l", sessionIds: ["b"] },
      { owner: STUDIO, directory: "/q", sessionIds: ["d"] },
    ]);
    expect(plan.unresolved).toEqual([{ id: "zz", reason: "unknown" }]);
  });

  it("an id appears in at most one of statuses / unresolved", async () => {
    const ownerMap = ownerMapOf([["ses-a", STUDIO, "/p"]]);
    const { fetchImpl } = fakeFetch({ [key(STUDIO_ORIGIN, "/p")]: { body: { "ses-a": { type: "busy" } } } });
    const res = await readFleetSessionStatus("ses-a,ses-a,ses-b", { ownerMap, sources: sources(), fetchImpl });
    const inStatuses = new Set(Object.keys(res.statuses));
    for (const u of res.unresolved) expect(inStatuses.has(u.id)).toBe(false);
    expect(res.unresolved.filter((u) => u.id === "ses-a")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — bounded (id cap 64, query cap 16, request order)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — bounded", () => {
  it("ids are trimmed, empty segments dropped, and de-duplicated (first occurrence wins) BEFORE the cap", () => {
    expect(parseStatusIds(" a , ,b,a,, c ")).toEqual(["a", "b", "c"]);
    expect(parseStatusIds("")).toEqual([]);
    expect(parseStatusIds(null)).toEqual([]);
    expect(parseStatusIds(undefined)).toEqual([]);
  });

  it(`accepts at most ${FLEET_STATUS_MAX_IDS} ids; ids past the cap are unresolved over-cap, never queried`, async () => {
    expect(FLEET_STATUS_MAX_IDS).toBe(64);
    // 70 distinct ids, all in ONE directory (so only the id cap bites); duplicates
    // and blanks padded in to prove the cap counts AFTER parse.
    const ids = Array.from({ length: 70 }, (_, i) => `s${i}`);
    const ownerMap = ownerMapOf(ids.map((id) => [id, STUDIO, "/p"] as [string, string, string]));
    const { fetchImpl, calls } = fakeFetch({ [key(STUDIO_ORIGIN, "/p")]: { body: {} } });
    const raw = ["s0", " ", ...ids, "s1", ""].join(",");
    const res = await readFleetSessionStatus(raw, { ownerMap, sources: sources(), fetchImpl });
    expect(calls).toHaveLength(1);
    expect(Object.keys(res.statuses)).toEqual(ids.slice(0, 64));
    expect(res.unresolved).toEqual(ids.slice(64).map((id) => ({ id, reason: "over-cap" })));
    expect(res.sources[STUDIO].directories["/p"].sessions).toBe(64);
  });

  it(`issues at most ${FLEET_STATUS_MAX_QUERIES} (owner, directory) queries, chosen in request order; sessions past the query cap are omitted and over-cap`, async () => {
    expect(FLEET_STATUS_MAX_QUERIES).toBe(16);
    // 20 directories; a 21st id re-uses directory #0 (already planned → NOT over-cap).
    const rows: Array<[string, string, string]> = Array.from({ length: 20 }, (_, i) => [`d${i}`, STUDIO, `/dir/${i}`]);
    rows.push(["d0-again", STUDIO, "/dir/0"]);
    const ownerMap = ownerMapOf(rows);
    const replies: Record<string, Reply> = {};
    for (let i = 0; i < 20; i++) replies[key(STUDIO_ORIGIN, `/dir/${i}`)] = { body: {} };
    const { fetchImpl, calls } = fakeFetch(replies);
    const res = await readFleetSessionStatus([...rows.map((r) => r[0])].join(","), { ownerMap, sources: sources(), fetchImpl });
    expect(calls).toHaveLength(16);
    expect(calls.map((c) => c.directory).sort()).toEqual(Array.from({ length: 16 }, (_, i) => `/dir/${i}`).sort());
    expect(res.statuses["d0-again"]).toEqual({ type: "idle" }); // rides an already-planned query
    for (let i = 16; i < 20; i++) expect(res.statuses[`d${i}`]).toBeUndefined();
    expect(res.unresolved).toEqual([16, 17, 18, 19].map((i) => ({ id: `d${i}`, reason: "over-cap" })));
    // an over-cap directory is not reported as a source directory (it was never planned)
    expect(Object.keys(res.sources[STUDIO].directories)).toHaveLength(16);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — bounded in time (concurrent, per-query timeout, 3 s overall deadline)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — bounded in time", () => {
  it("the overall deadline defaults to 3 s", () => {
    expect(FLEET_STATUS_DEADLINE_MS).toBe(3000);
    expect(FLEET_STATUS_QUERY_TIMEOUT_MS).toBeLessThanOrEqual(FLEET_STATUS_DEADLINE_MS);
  });

  it("all (owner, directory) queries run CONCURRENTLY (each answers only once every query has started)", async () => {
    const ownerMap = ownerMapOf([
      ["a", LOCAL, "/1"],
      ["b", STUDIO, "/2"],
      ["c", STUDIO, "/3"],
    ]);
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => (release = r));
    const fetchImpl = (async () => {
      started++;
      if (started === 3) release();
      await allStarted; // a sequential fan-out would park here until the deadline
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await readFleetSessionStatus("a,b,c", { ownerMap, sources: sources(), fetchImpl, deadlineMs: 1000 });
    expect(res.statuses).toEqual({ a: { type: "idle" }, b: { type: "idle" }, c: { type: "idle" } });
  });

  it("a query still pending at the deadline is `timeout`, its sessions omitted — and every status that DID arrive is returned", async () => {
    const ownerMap = ownerMapOf([
      ["ses-fast", STUDIO, "/fast"],
      ["ses-hung", STUDIO, "/hung"],
    ]);
    const { fetchImpl } = fakeFetch({
      [key(STUDIO_ORIGIN, "/fast")]: { body: { "ses-fast": { type: "busy" } } },
      [key(STUDIO_ORIGIN, "/hung")]: "hang", // ignores the abort signal entirely
    });
    const t0 = Date.now();
    const res = await readFleetSessionStatus("ses-fast,ses-hung", {
      ownerMap,
      sources: sources(),
      fetchImpl,
      deadlineMs: 80,
      queryTimeoutMs: 10_000, // only the overall deadline can cut this one
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.ok).toBe(true);
    expect(res.statuses).toEqual({ "ses-fast": { type: "busy" } });
    expect(res.sources[STUDIO].directories["/hung"]).toMatchObject({ ok: false, reason: "timeout", sessions: 1 });
  });

  it("each query has its OWN timeout (bounded per query, well inside the deadline)", async () => {
    const ownerMap = ownerMapOf([
      ["ses-ok", LOCAL, "/ok"],
      ["ses-slow", STUDIO, "/slow"],
    ]);
    const { fetchImpl } = fakeFetch({
      [key(LOCAL_ORIGIN, "/ok")]: { body: {} },
      [key(STUDIO_ORIGIN, "/slow")]: "hang-abortable",
    });
    const t0 = Date.now();
    const res = await readFleetSessionStatus("ses-ok,ses-slow", {
      ownerMap,
      sources: sources(),
      fetchImpl,
      deadlineMs: 5000,
      queryTimeoutMs: 40,
    });
    expect(Date.now() - t0).toBeLessThan(2000); // never waited for the 5 s deadline
    expect(res.statuses).toEqual({ "ses-ok": { type: "idle" } });
    expect(res.sources[STUDIO].directories["/slow"]).toMatchObject({ ok: false, reason: "timeout" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — validated statuses
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — validated statuses", () => {
  async function readOne(body: unknown, raw?: string) {
    const ownerMap = ownerMapOf([
      ["ses-1", STUDIO, "/p"],
      ["ses-other-dir", STUDIO, "/q"],
      ["ses-local", LOCAL, "/l"],
    ]);
    const { fetchImpl } = fakeFetch({
      [key(STUDIO_ORIGIN, "/p")]: raw !== undefined ? { raw } : { body },
      [key(STUDIO_ORIGIN, "/q")]: { body: { "ses-other-dir": { type: "busy" } } },
      [key(LOCAL_ORIGIN, "/l")]: { body: { "ses-local": { type: "busy" } } },
    });
    return readFleetSessionStatus("ses-1,ses-other-dir,ses-local", { ownerMap, sources: sources(), fetchImpl });
  }

  it.each([
    { name: "busy", entry: { type: "busy" }, out: { type: "busy" } },
    {
      name: "retry with its fields",
      entry: { type: "retry", attempt: 0, message: "overloaded", next: 5 },
      out: { type: "retry", attempt: 0, message: "overloaded", next: 5 },
    },
    {
      name: "retry with an action object",
      entry: { type: "retry", attempt: 3, message: "m", next: 9, action: { reason: "r", provider: "p", title: "t", message: "m", label: "l" } },
      out: { type: "retry", attempt: 3, message: "m", next: 9, action: { reason: "r", provider: "p", title: "t", message: "m", label: "l" } },
    },
    { name: "an explicit idle (accepted, reported idle)", entry: { type: "idle" }, out: { type: "idle" } },
    { name: "busy with an excess key (the engine schema ignores excess; only documented fields pass)", entry: { type: "busy", seq: 4 }, out: { type: "busy" } },
  ])("$name passes through", async ({ entry, out }) => {
    const res = await readOne({ "ses-1": entry });
    expect(res.statuses["ses-1"]).toStrictEqual(out);
    expect(res.sources[STUDIO].directories["/p"]).toEqual({ ok: true, sessions: 1 });
  });

  it.each([
    { name: "an array body", body: [] },
    { name: "a null body", body: null },
    { name: "a string body", body: "busy" },
    { name: "a number body", body: 7 },
    { name: "an entry with an unknown type", body: { "ses-1": { type: "running" } } },
    { name: "an entry that is not an object", body: { "ses-1": "busy" } },
    { name: "an entry that is null", body: { "ses-1": null } },
    { name: "retry missing `next`", body: { "ses-1": { type: "retry", attempt: 1, message: "m" } } },
    { name: "retry with a negative attempt", body: { "ses-1": { type: "retry", attempt: -1, message: "m", next: 1 } } },
    { name: "retry with a fractional next", body: { "ses-1": { type: "retry", attempt: 1, message: "m", next: 1.5 } } },
    { name: "retry with a non-string message", body: { "ses-1": { type: "retry", attempt: 1, message: 3, next: 1 } } },
    { name: "retry with a non-object action", body: { "ses-1": { type: "retry", attempt: 1, message: "m", next: 1, action: "x" } } },
    { name: "a bad entry for an UN-requested session", body: { "ses-1": { type: "busy" }, "ses-zz": { type: "??" } } },
  ])("$name marks ONLY that (owner, directory) malformed — its sessions omitted, other directories and owners unaffected", async ({ body }) => {
    const res = await readOne(body);
    expect(res.statuses["ses-1"]).toBeUndefined(); // omitted, never idle
    expect(res.sources[STUDIO].directories["/p"]).toMatchObject({ ok: false, reason: "malformed", sessions: 1 });
    expect(res.statuses["ses-other-dir"]).toEqual({ type: "busy" }); // same owner, other directory
    expect(res.statuses["ses-local"]).toEqual({ type: "busy" }); // other owner
    expect(res.sources[STUDIO].present).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC — never throws
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — never throws", () => {
  it.each([null, undefined, "", " , ,, "])("an empty request (%j) yields an empty map and makes NO upstream call", async (raw) => {
    const { fetchImpl, calls } = fakeFetch({});
    const res = await readFleetSessionStatus(raw, { ownerMap: ownerMapOf([]), sources: sources(), fetchImpl });
    expect(res).toEqual({ ok: true, statuses: {}, sources: {}, unresolved: [] });
    expect(calls).toEqual([]);
  });

  it("a garbled request (odd characters, a huge id) is well-formed: the ids are simply unknown", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const huge = "x".repeat(10_000);
    const res = await readFleetSessionStatus(`%%%,\u0000,${huge},../../etc`, { ownerMap: ownerMapOf([]), sources: sources(), fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.statuses).toEqual({});
    expect(res.unresolved.map((u) => u.reason)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(calls).toEqual([]);
  });

  it("a throwing owner map, a throwing source getter, and a throwing fetch all stay inside a well-formed response", async () => {
    const throwingMap = {
      resolveOwner: (id: string) => {
        if (id === "boom") throw new Error("owner map exploded");
        return STUDIO;
      },
      resolveDirectory: () => "/p",
    };
    const res1 = await readFleetSessionStatus("boom,ok", {
      ownerMap: throwingMap,
      sources: sources({ peers: [{ machineId: STUDIO, getUrl: () => { throw new Error("roster gone"); }, token: "t" }] }),
      fetchImpl: (() => { throw new Error("sync throw"); }) as unknown as typeof fetch,
    });
    expect(res1.ok).toBe(true);
    expect(res1.statuses).toEqual({});
    expect(res1.unresolved).toEqual([{ id: "boom", reason: "unknown" }]);
    expect(res1.sources[STUDIO]).toMatchObject({ present: false, reason: "no-upstream" });

    const res2 = await readFleetSessionStatus("ok", {
      ownerMap: throwingMap,
      sources: sources(),
      fetchImpl: (() => { throw new Error("sync throw"); }) as unknown as typeof fetch,
    });
    expect(res2.ok).toBe(true);
    expect(res2.sources[STUDIO].directories["/p"]).toMatchObject({ ok: false, reason: "fetch-failed" });
  });
});

describe("#1766 — id strings that collide with object internals", () => {
  it("a requested id named like an Object.prototype key resolves only from the owner's real answer", async () => {
    const ownerMap = ownerMapOf([
      ["constructor", STUDIO, "/p"],
      ["toString", STUDIO, "/p"],
    ]);
    const { fetchImpl } = fakeFetch({ [key(STUDIO_ORIGIN, "/p")]: { body: { toString: { type: "busy" } } } });
    const res = await readFleetSessionStatus("constructor,toString", { ownerMap, sources: sources(), fetchImpl });
    expect(res.statuses.constructor).toStrictEqual({ type: "idle" }); // absent ⇒ idle, NOT Object
    expect(res.statuses.toString).toStrictEqual({ type: "busy" });
  });
});
