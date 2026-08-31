import { describe, it, expect } from "vitest";
import { resolveLlmCreds, stripProviders, fetchProviderSignal } from "../src/llm_creds.mjs";

// 0.3 — the LLM-provider SIGNAL: amico stores/injects no credential; opencode
// owns the secret, and amico computes the configured/missing/mismatch signal
// from opencode's OWN live /config/providers. Tests cover the pure signal, the
// no-leak strip boundary, and the async fetch against a stubbed endpoint.

describe("resolveLlmCreds — pure signal from opencode-resolved providers", () => {
  it("not configured → ONE explicit signal when opencode resolves no provider", () => {
    const r = resolveLlmCreds({ providers: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/not configured/i);
      expect(r.fix).toMatch(/provider|RUNBOOK/i);
    }
  });
  it("configured → ok when a provider resolves and no model pins one", () => {
    const r = resolveLlmCreds({ providers: [{ id: "anthropic", source: "env" }] });
    expect(r).toMatchObject({ ok: true, provider: "anthropic", source: "env" });
  });
  it("configured → ok when the model provider is among the resolved ones", () => {
    const r = resolveLlmCreds({
      providers: [
        { id: "amazon-bedrock", source: "config" },
        { id: "anthropic", source: "env" },
      ],
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(r).toMatchObject({ ok: true, provider: "anthropic", source: "env" });
  });
  it("mismatch → ok with warning when the model points at an unresolved provider (falls back to first resolved)", () => {
    const r = resolveLlmCreds({
      providers: [{ id: "anthropic", source: "env" }],
      model: "amazon-bedrock/us.anthropic.claude-sonnet-4-6",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("anthropic");
      expect(r.source).toBe("env");
      expect(r.warning).toMatch(/amazon-bedrock/);
      expect(r.warning).toMatch(/falling back/i);
    }
  });
  it('ignores a model with no provider prefix (falls back to "any resolved")', () => {
    const r = resolveLlmCreds({ providers: [{ id: "openai", source: "env" }], model: "weird-model-no-slash" });
    expect(r).toMatchObject({ ok: true, provider: "openai" });
  });
});

describe("stripProviders — the no-leak boundary", () => {
  it("keeps only {id, source} and DROPS the plaintext key + everything else", () => {
    const raw = {
      providers: [
        { id: "anthropic", source: "env", key: "sk-ant-SECRET", models: { a: {} }, options: {} },
        { id: "amazon-bedrock", source: "config", env: ["AWS_ACCESS_KEY_ID"] },
      ],
    };
    const stripped = stripProviders(raw);
    expect(stripped).toEqual([
      { id: "anthropic", source: "env" },
      { id: "amazon-bedrock", source: "config" },
    ]);
    // The secret must not survive the strip — in ANY field.
    expect(JSON.stringify(stripped)).not.toContain("sk-ant-SECRET");
  });
  it("tolerates a missing/empty providers array", () => {
    expect(stripProviders({})).toEqual([]);
    expect(stripProviders(null)).toEqual([]);
    expect(stripProviders({ providers: [] })).toEqual([]);
  });
});

describe("fetchProviderSignal — async, against a stubbed opencode server", () => {
  const SECRET = "sk-ant-DO-NOT-LEAK";
  const stub = (routes: Record<string, unknown>, status = 200) =>
    (async (url: string) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: status < 400, status, json: async () => routes[path] } as Response;
    }) as unknown as typeof fetch;

  it("ok + which-provider when the live server resolves one, and NEVER returns a key", async () => {
    const fetchImpl = stub({
      "/config/providers": { providers: [{ id: "anthropic", source: "env", key: SECRET }] },
      "/config": { model: "anthropic/claude-sonnet-4-6" },
    });
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl });
    expect(sig).toMatchObject({ ok: true, provider: "anthropic", source: "env" });
    // AC6: the secret in the raw response must not appear anywhere in the signal.
    expect(JSON.stringify(sig)).not.toContain(SECRET);
  });
  it("not configured when the live server resolves zero providers", async () => {
    const fetchImpl = stub({ "/config/providers": { providers: [] }, "/config": {} });
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl });
    expect(sig.ok).toBe(false);
    if (!sig.ok) expect(sig.reason).toMatch(/not configured/i);
  });
  it("mismatch is a soft warning through the async path too (chat still opens)", async () => {
    const fetchImpl = stub({
      "/config/providers": { providers: [{ id: "anthropic", source: "env" }] },
      "/config": { model: "amazon-bedrock/x" },
    });
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl });
    expect(sig.ok).toBe(true);
    if (sig.ok) {
      expect(sig.provider).toBe("anthropic");
      expect(sig.warning).toMatch(/amazon-bedrock/);
    }
  });
  it("not-ok (not a throw) when /config/providers is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl });
    expect(sig.ok).toBe(false);
    if (!sig.ok) expect(sig.reason).toMatch(/could not query|providers/i);
  });
  it("still ok when /config (model) is unavailable — model check is optional", async () => {
    const fetchImpl = stub({ "/config/providers": { providers: [{ id: "openai", source: "env" }] } }); // no /config route → 404
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl });
    expect(sig).toMatchObject({ ok: true, provider: "openai" });
  });
  it("carries the caller's auth headers on BOTH endpoint fetches (fork route auth, #163)", async () => {
    // With OPENCODE_SERVER_PASSWORD armed, /config/providers and /config 401
    // without the Basic credential — the extension's signal probes would read
    // "server unreachable" forever. The headers option is how extension.ts
    // authenticates them.
    const seen: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      seen[path] = init?.headers;
      const routes: Record<string, unknown> = {
        "/config/providers": { providers: [{ id: "anthropic", source: "env" }] },
        "/config": { model: "anthropic/claude-sonnet-4-6" },
      };
      return { ok: true, status: 200, json: async () => routes[path] } as Response;
    }) as unknown as typeof fetch;
    const headers = { Authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` };
    const sig = await fetchProviderSignal("http://127.0.0.1:9", { fetchImpl, headers });
    expect(sig.ok).toBe(true);
    expect(seen["/config/providers"]).toMatchObject(headers); // the signal probe authenticates
    expect(seen["/config"]).toMatchObject(headers); // …and so does the model read
  });
});
