import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchOpencode,
  loadManifest,
  sha256,
  classifyDownloadError,
  withRetry,
} from "../scripts/fetch_opencode.mjs";

function rootWith(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "oc-retry-"));
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(manifest));
  return root;
}

function fixtureArchive(): { bytes: Buffer; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-fixture-"));
  writeFileSync(join(dir, "opencode"), "#!/bin/sh\necho fake-opencode\n");
  chmodSync(join(dir, "opencode"), 0o755);
  execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, "opencode"]);
  const bytes = readFileSync(join(dir, "a.tar.gz"));
  return { bytes, hash: sha256(bytes) };
}

// ── #1019: Release download robustness tests ──

describe("withRetry — exponential backoff (#1019)", () => {
  it("succeeds on first attempt with no retry", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => { calls++; return Buffer.from("ok"); },
      { maxAttempts: 3, baseDelay: 10, factor: 2 },
    );
    expect(result.toString()).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient failures up to maxAttempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error("HTTP 503: Service Unavailable");
      return Buffer.from("success");
    };
    const result = await withRetry(fn, { maxAttempts: 3, baseDelay: 10, factor: 2 });
    expect(result.toString()).toBe("success");
    expect(calls).toBe(3);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("HTTP 500: Internal Server Error");
    };
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelay: 10, factor: 2 }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(3);
  });

  it("does not retry permanent errors (404, 403)", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      const err = new Error("HTTP 404: Not Found");
      (err as any).permanent = true;
      throw err;
    };
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelay: 10, factor: 2, isPermanent: (e) => (e as any).permanent }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("calls onRetry callback between attempts", async () => {
    const retries: number[] = [];
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return Buffer.from("ok");
    };
    await withRetry(fn, {
      maxAttempts: 3,
      baseDelay: 10,
      factor: 2,
      onRetry: (attempt, _err) => retries.push(attempt),
    });
    expect(retries).toEqual([1, 2]);
  });
});

describe("classifyDownloadError (#1019)", () => {
  it("classifies 5xx as transient", () => {
    expect(classifyDownloadError(new Error("HTTP 500: Internal Server Error"))).toBe("transient");
    expect(classifyDownloadError(new Error("HTTP 502: Bad Gateway"))).toBe("transient");
    expect(classifyDownloadError(new Error("HTTP 503: Service Unavailable"))).toBe("transient");
  });

  it("classifies timeout/reset as transient", () => {
    expect(classifyDownloadError(new Error("network timeout"))).toBe("transient");
    expect(classifyDownloadError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyDownloadError(new Error("ETIMEDOUT"))).toBe("transient");
    expect(classifyDownloadError(new Error("UND_ERR_CONNECT_TIMEOUT"))).toBe("transient");
  });

  it("classifies 404 as permanent", () => {
    expect(classifyDownloadError(new Error("HTTP 404: Not Found"))).toBe("permanent");
  });

  it("classifies 403 as auth", () => {
    expect(classifyDownloadError(new Error("HTTP 403: Forbidden"))).toBe("auth");
  });

  it("classifies gh-not-found as auth", () => {
    expect(classifyDownloadError(new Error("gh: command not found"))).toBe("auth");
    expect(classifyDownloadError(new Error("not logged in"))).toBe("auth");
  });
});

describe("fetchFromRelease retry + fallback (#1019)", () => {
  it("retries transient HTTPS failures then succeeds", async () => {
    const { bytes, hash } = fixtureArchive();
    const root = rootWith({
      version: "9.9.9",
      repo: "harmoniqs/opencode",
      tag: "v9.9.9-amicode.1",
      platforms: { "linux-x64": { asset: "a.tar.gz", sha256: hash } },
    });
    let calls = 0;
    const download = async (_url: string) => {
      calls++;
      if (calls < 3) throw new Error("HTTP 503: Service Unavailable");
      return bytes;
    };
    const r = await fetchOpencode({
      root,
      platform: "linux-x64",
      download,
      retryOpts: { maxAttempts: 3, baseDelay: 10, factor: 2 },
    });
    expect(r.skipped).toBe(false);
    expect(calls).toBe(3);
    expect(existsSync(join(root, "vendor", "opencode", "linux-x64", "opencode"))).toBe(true);
  });

  it("HTTPS sha256 mismatch triggers one gh fallback attempt", async () => {
    const { bytes, hash } = fixtureArchive();
    // Create a corrupt version
    const corrupt = Buffer.concat([bytes, Buffer.from("corruption")]);
    const root = rootWith({
      version: "9.9.9",
      repo: "harmoniqs/opencode",
      tag: "v9.9.9-amicode.1",
      platforms: { "linux-x64": { asset: "a.tar.gz", sha256: hash } },
    });
    // HTTPS returns corrupt, then gh would be tried — but gh is not available
    // in tests, so the final error should mention the fallback
    const download = async () => corrupt;
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(
        fetchOpencode({
          root,
          platform: "linux-x64",
          download,
          retryOpts: { maxAttempts: 1, baseDelay: 10, factor: 2 },
        }),
      ).rejects.toThrow(/SHA256 mismatch|gh fallback/);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("no partial binary left after interrupted download", async () => {
    const root = rootWith({
      version: "9.9.9",
      repo: "harmoniqs/opencode",
      tag: "v9.9.9-amicode.1",
      platforms: { "linux-x64": { asset: "a.tar.gz", sha256: "ee".repeat(32) } },
    });
    const download = async () => { throw new Error("ECONNRESET"); };
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(
        fetchOpencode({
          root,
          platform: "linux-x64",
          download,
          retryOpts: { maxAttempts: 1, baseDelay: 10, factor: 2 },
        }),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = prevPath;
    }
    // No partial binary should exist
    expect(existsSync(join(root, "vendor", "opencode", "linux-x64", "opencode"))).toBe(false);
    // No .unpack- temp dirs should remain
    const vendorDir = join(root, "vendor", "opencode", "linux-x64");
    if (existsSync(vendorDir)) {
      const files = require("fs").readdirSync(vendorDir);
      const partials = files.filter((f: string) => f.startsWith(".unpack-"));
      expect(partials).toHaveLength(0);
    }
  });

  it("permanent 404 is not retried on HTTPS (falls through to gh once)", async () => {
    const root = rootWith({
      version: "9.9.9",
      repo: "harmoniqs/opencode",
      tag: "v9.9.9-amicode.1",
      platforms: { "linux-x64": { asset: "a.tar.gz", sha256: "ee".repeat(32) } },
    });
    let calls = 0;
    const download = async () => {
      calls++;
      throw new Error("HTTP 404: Not Found");
    };
    const prevPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(
        fetchOpencode({
          root,
          platform: "linux-x64",
          download,
          retryOpts: { maxAttempts: 3, baseDelay: 10, factor: 2 },
        }),
      ).rejects.toThrow(/not publicly fetchable|gh fallback/);
    } finally {
      process.env.PATH = prevPath;
    }
    // 404 should not be retried — only 1 HTTPS attempt before gh fallback
    expect(calls).toBe(1);
  });
});
