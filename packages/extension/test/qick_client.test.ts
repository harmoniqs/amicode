import { describe, it, expect } from "vitest";
import { SchusterJobServer, SnowbirdMcpJobServer, isQilcEntitled, type FetchLike } from "../src/qick_client";

// Spec A §2.3 (adapters) + §5.2 (entitlement predicate). Both HTTP adapters are
// NEVER-REJECT: a dead tunnel / 500 / timeout → {ok:false,...}, never a throw
// (§6 crit 5). The entitlement authority is package resolution (Intonatissimo),
// driven here through an injectable command runner — no Julia in the test.

const jsonRes = (body: unknown, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("SchusterJobServer — never-reject HTTP adapter (§6 crit 5)", () => {
  it("maps verbs onto the FastAPI and parses results", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/jobs/submit")) return jsonRes({ job_id: "JOB-9" });
      if (url.endsWith("/jobs/queue")) return jsonRes({ running: null, pending: [{ job_id: "JOB-9", status: "pending" }] });
      if (url.includes("/health")) return jsonRes({ ok: true, stats: { pending: 1, running: 0 }, capabilities: ["qilc"], channels: ["ch0"] });
      return jsonRes({});
    };
    const js = new SchusterJobServer({ baseUrl: "http://localhost:8000", fetchImpl });
    const sub = await js.submit({ user: "amico", experiment: { adapter: "schuster", payload: {} } });
    expect(sub.ok && sub.value.job_id).toBe("JOB-9");
    const q = await js.queue();
    expect(q.ok && q.value.pending.map((j) => j.job_id)).toEqual(["JOB-9"]);
    const h = await js.health();
    expect(h.ok && h.value.capabilities).toEqual(["qilc"]);
    expect(h.ok && h.value.channels).toEqual(["ch0"]);
    expect(calls).toContain("POST http://localhost:8000/jobs/submit");
  });

  it("a 500 degrades to {ok:false}, never throws", async () => {
    const js = new SchusterJobServer({ baseUrl: "http://x", fetchImpl: async () => jsonRes({}, 500) });
    const q = await js.queue();
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error).toContain("500");
  });

  it("a network throw / timeout degrades to {ok:false}, never throws", async () => {
    const js = new SchusterJobServer({
      baseUrl: "http://x",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const h = await js.health();
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.error.toLowerCase()).toContain("network");
  });

  it("malformed JSON on a 200 still never throws (degrades to error)", async () => {
    const js = new SchusterJobServer({
      baseUrl: "http://x",
      fetchImpl: async () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error("bad json"); }, text: async () => "oops" }),
    });
    const q = await js.queue();
    expect(q.ok).toBe(false);
  });
});

describe("SnowbirdMcpJobServer — verbs onto MCP tool calls", () => {
  it("submit dispatches the tool named in the experiment payload", async () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const js = new SnowbirdMcpJobServer({ callTool: async (tool, args) => { seen.push({ tool, args }); return { data_file_path: "/tmp/x.h5" }; } });
    const r = await js.submit({ user: "amico", experiment: { adapter: "mcp", payload: { tool: "t2_ramsey", config: { reps: 1000 } } } });
    expect(r.ok).toBe(true);
    expect(seen[0].tool).toBe("t2_ramsey");
  });
  it("a throwing tool call degrades to {ok:false}, never throws", async () => {
    const js = new SnowbirdMcpJobServer({ callTool: async () => { throw new Error("mcp down"); } });
    const r = await js.submit({ user: "a", experiment: { adapter: "mcp", payload: { tool: "t1" } } });
    expect(r.ok).toBe(false);
  });
  it("queue is empty (MCP is synchronous — no persistent queue) → idle-safe", async () => {
    const js = new SnowbirdMcpJobServer({ callTool: async () => ({}) });
    const q = await js.queue();
    expect(q.ok && q.value).toEqual({ running: undefined, pending: [] });
  });
});

describe("isQilcEntitled — package-resolution authority (§5.2)", () => {
  it("resolvable Intonatissimo → true", async () => {
    expect(await isQilcEntitled("/env", async () => ({ code: 0 }))).toBe(true);
  });
  it("absent package → false", async () => {
    expect(await isQilcEntitled("/env", async () => ({ code: 1 }))).toBe(false);
  });
  it("a runner that throws (no julia) → false, never throws", async () => {
    expect(await isQilcEntitled("/env", async () => { throw new Error("julia not found"); })).toBe(false);
  });
});
