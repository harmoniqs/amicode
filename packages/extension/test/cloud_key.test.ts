import { describe, it, expect } from "vitest";
import {
  classifyValidation,
  buildCloudConfig,
  validateCloudKey,
  DEFAULT_CLOUD_URL,
  type ValidationOutcome,
} from "../src/cloud_key";

const SECRET = "sk-super-secret-token-abc123";

describe("classifyValidation", () => {
  it("401 → invalid (authorizer rejected the bearer)", () => {
    expect(classifyValidation(401).kind).toBe("invalid");
  });

  it("403 → valid (authorizer accepted; probe just isn't the caller's task)", () => {
    expect(classifyValidation(403).kind).toBe("valid");
  });

  it("404 → valid (authorizer accepted; the fake probe task doesn't exist)", () => {
    expect(classifyValidation(404).kind).toBe("valid");
  });

  it("200 → valid (auth passed, handler reached)", () => {
    expect(classifyValidation(200).kind).toBe("valid");
  });

  it("500 (and other unexpected) → error, not a save", () => {
    const r = classifyValidation(500);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/500/);
  });
});

describe("buildCloudConfig", () => {
  it("produces exactly the {base_url, token} shape remote_config.ts reads", () => {
    const cfg = buildCloudConfig("https://example.com", SECRET);
    expect(cfg).toEqual({ base_url: "https://example.com", token: SECRET });
    // No extra keys — remote_config's readers key off base_url + token only.
    expect(Object.keys(cfg).sort()).toEqual(["base_url", "token"]);
  });

  it("strips a trailing slash from base_url (remote_config strips too; keep them aligned)", () => {
    expect(buildCloudConfig("https://example.com/", SECRET).base_url).toBe("https://example.com");
    expect(buildCloudConfig("https://example.com///", SECRET).base_url).toBe("https://example.com");
  });
});

describe("validateCloudKey (injected fetch — no live network)", () => {
  const fakeFetch = (status: number): typeof fetch =>
    (async () => ({ status }) as Response) as unknown as typeof fetch;

  it("hits the poll probe endpoint with a Bearer header (token never in URL)", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const spyFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return { status: 404 } as Response;
    }) as unknown as typeof fetch;
    await validateCloudKey("https://api.example.com", SECRET, spyFetch);
    expect(seenUrl).toBe("https://api.example.com/solves/__validate__/status");
    expect(seenUrl).not.toContain(SECRET);
    expect(seenAuth).toBe(`Bearer ${SECRET}`);
  });

  it("401 → invalid outcome", async () => {
    const r = await validateCloudKey("https://api.example.com", SECRET, fakeFetch(401));
    expect(r.kind).toBe("invalid");
  });

  it("403 → valid outcome", async () => {
    const r = await validateCloudKey("https://api.example.com", SECRET, fakeFetch(403));
    expect(r.kind).toBe("valid");
  });

  it("404 → valid outcome", async () => {
    const r = await validateCloudKey("https://api.example.com", SECRET, fakeFetch(404));
    expect(r.kind).toBe("valid");
  });

  it("200 → valid outcome", async () => {
    const r = await validateCloudKey("https://api.example.com", SECRET, fakeFetch(200));
    expect(r.kind).toBe("valid");
  });

  it("network failure → error outcome, and the token never leaks into the message", async () => {
    const throwingFetch = (async () => {
      throw new Error(`connect ECONNREFUSED for ${SECRET}`); // adversarial: token in the raw error
    }) as unknown as typeof fetch;
    const r = await validateCloudKey("https://api.example.com", SECRET, throwingFetch);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).not.toContain(SECRET);
  });
});

describe("token never leaks into any returned error/outcome string", () => {
  const outcomes: ValidationOutcome[] = [
    classifyValidation(401),
    classifyValidation(403),
    classifyValidation(404),
    classifyValidation(200),
    classifyValidation(500),
  ];
  it("no outcome message contains the token", () => {
    for (const o of outcomes) {
      const msg = o.kind === "error" || o.kind === "invalid" ? o.message : "";
      expect(msg).not.toContain(SECRET);
    }
  });
});

describe("DEFAULT_CLOUD_URL", () => {
  it("matches the production Solve Service base URL", () => {
    expect(DEFAULT_CLOUD_URL).toBe("https://qy2gwqy5s5.execute-api.us-east-1.amazonaws.com");
  });
});
