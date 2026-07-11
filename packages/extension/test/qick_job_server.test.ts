import { describe, it, expect } from "vitest";
import { MockJobServer, parseQueue, parseHistory, parseConfigVersions } from "../src/qick_job_server";

// Spec A §2 — the QICK job-server (QUEUE) contract. Distinct from the 3-verb
// measurement contract (expt_service, Spec B) and from Raghav's internal
// Scheduler/RunsManager. MockJobServer is in-memory + deterministic (counter
// ids, NO Date.now/Math.random) so every §6 acceptance test runs headless.

describe("QICK job-server (queue) contract", () => {
  it("MockJobServer: submit → queue → run → history", async () => {
    const js = new MockJobServer();
    const { job_id } = await js.submit({ user: "amico", experiment: { adapter: "mock", payload: {} }, priority: 0 });
    expect((await js.queue()).pending.map((j) => j.job_id)).toContain(job_id);
    await js.runNext({ result: { pi_amp: 0.031 } });
    expect((await js.queue()).running).toBeUndefined();
    expect((await js.history({})).some((j) => j.job_id === job_id && j.status === "completed")).toBe(true);
  });
  it("idle ⟺ no running AND no pending", async () => {
    const js = new MockJobServer();
    expect((await js.queue()).running).toBeUndefined();
    await js.submit({ user: "a", experiment: { adapter: "mock", payload: {} }, priority: 0 });
    const q = await js.queue();
    expect(q.running !== undefined || q.pending.length > 0).toBe(true);
  });
  it("capabilities settable (advisory entitlement hint)", async () => {
    expect((await new MockJobServer({ capabilities: ["qilc"] }).health()).capabilities).toEqual(["qilc"]);
  });
  it("parsers never throw on junk", () => {
    expect(parseQueue(undefined)).toEqual({ running: undefined, pending: [] });
    expect(parseHistory("garbage")).toEqual([]);
    expect(parseConfigVersions(null)).toEqual([]);
  });
  it("priority-then-FIFO ordering is deterministic", async () => {
    const js = new MockJobServer();
    const a = await js.submit({ user: "u", experiment: { adapter: "mock", payload: {} }, priority: 0 });
    const b = await js.submit({ user: "u", experiment: { adapter: "mock", payload: {} }, priority: 5 });
    const c = await js.submit({ user: "u", experiment: { adapter: "mock", payload: {} }, priority: 0 });
    // higher priority first (b), then FIFO among equal priority (a before c)
    expect((await js.queue()).pending.map((j) => j.job_id)).toEqual([b.job_id, a.job_id, c.job_id]);
    // deterministic ids from a counter (no Date.now / Math.random)
    expect([a.job_id, b.job_id, c.job_id]).toEqual(["JOB-1", "JOB-2", "JOB-3"]);
    const run = await js.runNext();
    expect(run?.job_id).toBe(b.job_id); // the highest priority runs first
  });
  it("cancel removes a pending job; config-versioning round-trips", async () => {
    const js = new MockJobServer();
    const { job_id } = await js.submit({ user: "u", experiment: { adapter: "mock", payload: {} } });
    expect(await js.cancel(job_id)).toBe(true);
    expect((await js.queue()).pending).toHaveLength(0);
    const ver = await js.pushConfig("hw", { pi_amp: 0.03 });
    await js.setMain("hw", ver.version_id);
    expect((await js.mainConfig("hw"))?.version_id).toBe(ver.version_id);
    expect((await js.configVersions("hw")).map((v) => v.version_id)).toContain(ver.version_id);
  });
});
