// #1571: a real hasInflightTurns() — the safety check that was never built for
// the live restart path. Backed by the engine's own session.status frames
// (busy/retry open a turn, idle closes it) plus an optional /session/status
// probe for turns that began before this window adopted the survivor.
import { describe, it, expect } from "vitest";
import { InflightTurnTracker, probeBusySessions } from "../src/inflight_turns";

const status = (sessionID: string, type: string, seq?: number) => ({
  type: "session.status",
  properties: { sessionID, status: { type }, ...(seq === undefined ? {} : { seq }) },
});

describe("InflightTurnTracker", () => {
  it("is idle until a busy frame, in flight while busy, idle after the idle frame", () => {
    const t = new InflightTurnTracker();
    expect(t.hasInflightTurns()).toBe(false);
    t.observe(status("s1", "busy"));
    expect(t.hasInflightTurns()).toBe(true);
    t.observe(status("s1", "idle"));
    expect(t.hasInflightTurns()).toBe(false);
  });

  it("treats retry as still in flight", () => {
    const t = new InflightTurnTracker();
    t.observe(status("s1", "busy"));
    t.observe(status("s1", "retry"));
    expect(t.hasInflightTurns()).toBe(true);
  });

  it("stays in flight until EVERY busy session is idle", () => {
    const t = new InflightTurnTracker();
    t.observe(status("a", "busy"));
    t.observe(status("b", "busy"));
    t.observe(status("a", "idle"));
    expect(t.hasInflightTurns()).toBe(true);
    t.observe(status("b", "idle"));
    expect(t.hasInflightTurns()).toBe(false);
  });

  it("drops stale/replayed frames by seq (a late old idle never closes a newer busy)", () => {
    const t = new InflightTurnTracker();
    t.observe(status("s1", "busy", 5));
    t.observe(status("s1", "idle", 4));
    expect(t.hasInflightTurns()).toBe(true);
    t.observe(status("s1", "idle", 6));
    expect(t.hasInflightTurns()).toBe(false);
  });

  it("a deleted session is no longer in flight", () => {
    const t = new InflightTurnTracker();
    t.observe(status("s1", "busy"));
    t.observe({ type: "session.deleted", properties: { info: { id: "s1" } } });
    expect(t.hasInflightTurns()).toBe(false);
  });

  it("ignores malformed and unrelated events", () => {
    const t = new InflightTurnTracker();
    t.observe({ type: "session.status", properties: {} });
    t.observe({ type: "session.status" });
    t.observe({ type: "message.updated", properties: { sessionID: "s1" } });
    expect(t.hasInflightTurns()).toBe(false);
  });

  it("onQuiesce fires when the last in-flight turn ends — not before, once per transition", () => {
    const t = new InflightTurnTracker();
    let fired = 0;
    t.onQuiesce(() => { fired++; });
    t.observe(status("a", "busy"));
    t.observe(status("b", "busy"));
    t.observe(status("a", "idle"));
    expect(fired).toBe(0);
    t.observe(status("b", "idle"));
    expect(fired).toBe(1);
    t.observe(status("b", "idle", 99)); // already idle: no transition
    expect(fired).toBe(1);
  });

  it("onQuiesce unsubscribe stops delivery; a throwing listener does not break others", () => {
    const t = new InflightTurnTracker();
    let fired = 0;
    t.onQuiesce(() => { throw new Error("boom"); });
    const off = t.onQuiesce(() => { fired++; });
    t.observe(status("a", "busy"));
    t.observe(status("a", "idle"));
    expect(fired).toBe(1);
    off();
    t.observe(status("a", "busy"));
    t.observe(status("a", "idle"));
    expect(fired).toBe(1);
  });
});

describe("probeBusySessions", () => {
  const ok = (body: unknown) => async () => ({ ok: true, json: async () => body }) as unknown as Response;

  it("counts non-idle sessions in the /session/status map", async () => {
    const n = await probeBusySessions("http://127.0.0.1:1/", {
      fetchImpl: ok({ a: { type: "busy" }, b: { type: "idle" }, c: { type: "retry" } }),
    });
    expect(n).toBe(2);
  });

  it("an empty map is zero in flight", async () => {
    expect(await probeBusySessions("http://x/", { fetchImpl: ok({}) })).toBe(0);
  });

  it("returns undefined (unknown) on network error, non-ok, or a non-object body", async () => {
    expect(await probeBusySessions("http://x/", { fetchImpl: async () => { throw new Error("down"); } })).toBeUndefined();
    expect(await probeBusySessions("http://x/", {
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    })).toBeUndefined();
    expect(await probeBusySessions("http://x/", { fetchImpl: ok([1, 2]) })).toBeUndefined();
  });

  it("hits /session/status with the auth header", async () => {
    let seen: { url?: string; auth?: string } = {};
    await probeBusySessions("http://127.0.0.1:43117/", {
      headers: { Authorization: "Basic x" },
      fetchImpl: (async (url: string, init?: { headers?: Record<string, string> }) => {
        seen = { url: String(url), auth: init?.headers?.Authorization };
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect(seen.url).toBe("http://127.0.0.1:43117/session/status");
    expect(seen.auth).toBe("Basic x");
  });
});
