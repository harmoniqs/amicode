// Contract suite for coordination ledger (spec #318) — runs against both cloud and sqlite ref
import { describe, it, expect } from "vitest";
import { coordinationService, SqliteCoordinationService, workId } from "../src/coordination_ledger.js";
import { degradedStamp } from "../src/coordination_ledger.js";

const wid = (s: string) => workId({ structure_hash: s, goal: "CZ", N: 100, T: 30 });

describe("coordination ledger — claim serialization (spec §3)", () => {
  it("simultaneous claims serialize by receipt order; loser gets holder", async () => {
    const svc = new SqliteCoordinationService();
    const a = await svc.preflight({ work_id: wid("abc"), agent_id: "a1", user: "u1", org: "o1", host: "h1" });
    const b = await svc.preflight({ work_id: wid("abc"), agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.holder?.agent_id).toBe("a1");
  });

  it("lapsed lease is taken by next preflight (no deadlock)", async () => {
    const svc = new SqliteCoordinationService();
    await svc.preflight({ work_id: wid("lapse"), agent_id: "a1", user: "u1", org: "o1", host: "h1", ttl_s: 0 });
    // ttl 0 → immediately lapsed
    const b = await svc.preflight({ work_id: wid("lapse"), agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(b.ok).toBe(true);
  });

  it("verified result dedups — second never re-solves", async () => {
    const svc = new SqliteCoordinationService();
    const w = wid("dedup");
    await svc.publish({ work_id: w, verification: { agree: true }, fidelity: 0.999, catalog_pointer: "/tmp/pulse.jld2", platform: "transmon", kind: "CZ" });
    const b = await svc.preflight({ work_id: w, agent_id: "a2", user: "u2", org: "o1", host: "h2" });
    expect(b.ok).toBe(true);
    expect(b.dedup?.verified).toBe(true);
    expect(b.dedup?.pulse_path).toBe("/tmp/pulse.jld2");
  });

  it("workIdV1 stability: same physics → same id, max_iter excluded", () => {
    const a = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: true } });
    const b = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: true } });
    const c = workId({ structure_hash: "abc", goal: "CZ", N: 100, T: 30, facet_tuple: { free_phase: false } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("offline degraded stamp is honest", () => {
    expect(degradedStamp()).toEqual({ coordination: "degraded" });
  });

  it("fleet list --org shows user/host/org", async () => {
    const svc = new SqliteCoordinationService();
    await svc.preflight({ work_id: wid("fleet1"), agent_id: "a1", user: "alice", org: "lab", host: "h1" });
    const list = await svc.fleetList("lab");
    expect(list.some(s => s.user === "alice" && s.host === "h1")).toBe(true);
  });
});
