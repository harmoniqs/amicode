// Credential Scanner tests — Auto-Import Credentials (#449)
//
// Tests the credential scanning module: source priority, deduplication,
// normalization, shell RC parsing safety, and the security invariant
// (keys never appear in webview-safe output).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  scanCredentials,
  type DetectedCredential,
  type ScanOptions,
  type ScanResult,
  webviewSafeResults,
} from "../src/credential_scanner";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cred-scan-"));
}

function writeJson(dir: string, filename: string, data: unknown): string {
  const p = path.join(dir, filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

function writeText(dir: string, filename: string, content: string): string {
  const p = path.join(dir, filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ─── Source priority and deduplication ───────────────────────────────────────

describe("scanCredentials — source priority (AC11)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns credentials from opencode account.json (highest priority)", async () => {
    const accountPath = writeJson(tmpDir, "account.json", {
      anthropic: { serviceID: "anthropic", token: "sk-ant-from-account" },
    });
    const result = await scanCredentials({
      accountJsonPath: accountPath,
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials.length).toBeGreaterThan(0);
    const ant = result.credentials.find((c) => c.provider === "anthropic");
    expect(ant).toBeDefined();
    expect(ant!.key).toBe("sk-ant-from-account");
    expect(ant!.source).toBe("opencode (account)");
  });

  it("returns credentials from opencode auth.json (priority 2)", async () => {
    const authPath = writeJson(tmpDir, "auth.json", {
      provider: { anthropic: { key: "sk-ant-from-auth" } },
    });
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: authPath,
      env: {},
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const ant = result.credentials.find((c) => c.provider === "anthropic");
    expect(ant).toBeDefined();
    expect(ant!.key).toBe("sk-ant-from-auth");
    expect(ant!.source).toBe("opencode (auth)");
  });

  it("returns credentials from environment variables (priority 3)", async () => {
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: { ANTHROPIC_API_KEY: "sk-ant-from-env", OPENAI_API_KEY: "sk-openai-env" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials.length).toBe(2);
    const ant = result.credentials.find((c) => c.provider === "anthropic");
    expect(ant!.key).toBe("sk-ant-from-env");
    expect(ant!.source).toBe("environment");
  });

  it("returns credentials from shell RC files (priority 4)", async () => {
    const rcPath = writeText(tmpDir, ".zshrc", 'export ANTHROPIC_API_KEY="sk-ant-from-rc"\n');
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    const ant = result.credentials.find((c) => c.provider === "anthropic");
    expect(ant).toBeDefined();
    expect(ant!.key).toBe("sk-ant-from-rc");
    expect(ant!.source).toContain(".zshrc");
  });

  it("returns credentials from Claude .credentials.json (priority 5, type:api only)", async () => {
    const claudePath = writeJson(tmpDir, ".credentials.json", [
      { type: "api", provider: "anthropic", key: "sk-ant-from-claude" },
      { type: "oauth", provider: "anthropic", token: "oauth-should-skip" },
    ]);
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [],
      claudeCredPath: claudePath,
    });
    const ant = result.credentials.find((c) => c.provider === "anthropic");
    expect(ant).toBeDefined();
    expect(ant!.key).toBe("sk-ant-from-claude");
    expect(ant!.source).toBe("Claude Code");
  });

  it("deduplicates: first source wins per provider (AC11)", async () => {
    // account.json has anthropic, env also has anthropic — account wins
    const accountPath = writeJson(tmpDir, "account.json", {
      anthropic: { serviceID: "anthropic", token: "sk-ant-ACCOUNT-WINS" },
    });
    const result = await scanCredentials({
      accountJsonPath: accountPath,
      authJsonPath: "/nonexistent",
      env: { ANTHROPIC_API_KEY: "sk-ant-ENV-LOSES" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const ants = result.credentials.filter((c) => c.provider === "anthropic");
    expect(ants).toHaveLength(1);
    expect(ants[0].key).toBe("sk-ant-ACCOUNT-WINS");
  });

  it("returns multiple providers from different sources", async () => {
    const accountPath = writeJson(tmpDir, "account.json", {
      anthropic: { serviceID: "anthropic", token: "sk-ant" },
    });
    const result = await scanCredentials({
      accountJsonPath: accountPath,
      authJsonPath: "/nonexistent",
      env: { OPENAI_API_KEY: "sk-openai" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials.length).toBe(2);
    expect(result.credentials.map((c) => c.provider).sort()).toEqual(["anthropic", "openai"]);
  });
});

// ─── Provider ID normalization ──────────────────────────────────────────────

describe("scanCredentials — provider normalization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes 'opencode-go' to 'opencode'", async () => {
    const accountPath = writeJson(tmpDir, "account.json", {
      "opencode-go": { serviceID: "opencode-go", token: "oc-key" },
    });
    const result = await scanCredentials({
      accountJsonPath: accountPath,
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const oc = result.credentials.find((c) => c.provider === "opencode");
    expect(oc).toBeDefined();
    expect(oc!.key).toBe("oc-key");
  });

  it("normalizes 'amazon-bedrock' from account.json", async () => {
    const accountPath = writeJson(tmpDir, "account.json", {
      "amazon-bedrock": { serviceID: "amazon-bedrock", token: "aws-key" },
    });
    const result = await scanCredentials({
      accountJsonPath: accountPath,
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const aws = result.credentials.find((c) => c.provider === "amazon-bedrock");
    expect(aws).toBeDefined();
  });

  it("maps OPENROUTER_API_KEY env var to 'openrouter' provider", async () => {
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: { OPENROUTER_API_KEY: "or-key" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const or = result.credentials.find((c) => c.provider === "openrouter");
    expect(or).toBeDefined();
    expect(or!.key).toBe("or-key");
  });

  it("maps GOOGLE_API_KEY env var to 'google' provider", async () => {
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: { GOOGLE_API_KEY: "AIza-key" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    const g = result.credentials.find((c) => c.provider === "google");
    expect(g).toBeDefined();
  });
});

// ─── Shell RC parsing safety ─────────────────────────────────────────────────

describe("scanCredentials — shell RC parsing (security)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses single-quoted export lines", async () => {
    const rcPath = writeText(tmpDir, ".bashrc", "export OPENAI_API_KEY='sk-single-quoted'\n");
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    const oi = result.credentials.find((c) => c.provider === "openai");
    expect(oi!.key).toBe("sk-single-quoted");
  });

  it("parses double-quoted export lines", async () => {
    const rcPath = writeText(tmpDir, ".zshrc", 'export OPENAI_API_KEY="sk-double-quoted"\n');
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    const oi = result.credentials.find((c) => c.provider === "openai");
    expect(oi!.key).toBe("sk-double-quoted");
  });

  it("parses unquoted export lines", async () => {
    const rcPath = writeText(tmpDir, ".zshrc", "export OPENAI_API_KEY=sk-unquoted\n");
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    const oi = result.credentials.find((c) => c.provider === "openai");
    expect(oi!.key).toBe("sk-unquoted");
  });

  it("ignores commented-out lines", async () => {
    const rcPath = writeText(
      tmpDir,
      ".zshrc",
      '# export OPENAI_API_KEY="sk-commented"\nexport ANTHROPIC_API_KEY=sk-real\n',
    );
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials.find((c) => c.provider === "openai")).toBeUndefined();
    expect(result.credentials.find((c) => c.provider === "anthropic")).toBeDefined();
  });

  it("does not execute shell commands or subshells", async () => {
    const rcPath = writeText(
      tmpDir,
      ".zshrc",
      'export OPENAI_API_KEY=$(echo "injected")\nexport ANTHROPIC_API_KEY=sk-safe\n',
    );
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    // The $(echo) line should be skipped or taken literally — never executed
    const oi = result.credentials.find((c) => c.provider === "openai");
    // If parsed, value would be literal `$(echo "injected")` or skipped entirely
    if (oi) {
      // If it didn't skip, the literal includes $( which is fine (not executed)
      expect(oi.key).not.toBe("injected");
    }
    // The safe key should always be found
    expect(result.credentials.find((c) => c.provider === "anthropic")!.key).toBe("sk-safe");
  });

  it("handles empty values gracefully (skips)", async () => {
    const rcPath = writeText(tmpDir, ".zshrc", "export OPENAI_API_KEY=\nexport ANTHROPIC_API_KEY=''\n");
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: [rcPath],
      claudeCredPath: "/nonexistent",
    });
    // Empty values should not create credentials
    expect(result.credentials).toHaveLength(0);
  });
});

// ─── Error handling (AC10) ───────────────────────────────────────────────────

describe("scanCredentials — error handling (AC10)", () => {
  it("skips unreadable files silently", async () => {
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent/account.json",
      authJsonPath: "/nonexistent/auth.json",
      env: { ANTHROPIC_API_KEY: "sk-works" },
      rcPaths: ["/nonexistent/.zshrc"],
      claudeCredPath: "/nonexistent/.credentials.json",
    });
    // Should still return the env var credential
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].provider).toBe("anthropic");
  });

  it("skips malformed JSON files silently", async () => {
    const tmpDir = makeTmpDir();
    const badJson = writeText(tmpDir, "account.json", "not valid json {{{");
    const result = await scanCredentials({
      accountJsonPath: badJson,
      authJsonPath: "/nonexistent",
      env: { OPENAI_API_KEY: "sk-still-works" },
      rcPaths: [],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].provider).toBe("openai");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty credentials array when all sources fail", async () => {
    const result = await scanCredentials({
      accountJsonPath: "/nonexistent",
      authJsonPath: "/nonexistent",
      env: {},
      rcPaths: ["/nonexistent"],
      claudeCredPath: "/nonexistent",
    });
    expect(result.credentials).toEqual([]);
  });
});

// ─── Security: webview-safe output (AC8) ─────────────────────────────────────

describe("webviewSafeResults — no key material leaks (AC8)", () => {
  it("strips keys from credentials for webview consumption", () => {
    const credentials: DetectedCredential[] = [
      { provider: "anthropic", key: "sk-ant-SENSITIVE", source: "environment" },
      { provider: "openai", key: "sk-openai-SENSITIVE", source: "opencode (account)" },
    ];
    const safe = webviewSafeResults(credentials);

    // Must NOT contain any key values
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("sk-ant-SENSITIVE");
    expect(serialized).not.toContain("sk-openai-SENSITIVE");

    // Must contain provider names and sources
    expect(safe).toHaveLength(2);
    expect(safe[0].provider).toBe("anthropic");
    expect(safe[0].source).toBe("environment");
    expect(safe[1].provider).toBe("openai");
    expect(safe[1].source).toBe("opencode (account)");
  });

  it("includes the default model for each detected provider", () => {
    const credentials: DetectedCredential[] = [
      { provider: "anthropic", key: "sk-x", source: "env" },
    ];
    const safe = webviewSafeResults(credentials);
    expect(safe[0].model).toBeTruthy();
    // Should be the first model from PROVIDER_MODELS for anthropic
    expect(safe[0].model).toContain("anthropic/");
  });

  it("no field matching /key|secret|token|credential/i contains a string > 8 chars", () => {
    const credentials: DetectedCredential[] = [
      { provider: "anthropic", key: "sk-ant-very-long-secret-key-12345", source: "environment" },
    ];
    const safe = webviewSafeResults(credentials);
    const serialized = JSON.stringify(safe);
    const parsed = JSON.parse(serialized);

    // Walk all string values in the result
    const checkObj = (obj: unknown): void => {
      if (typeof obj === "string") return;
      if (Array.isArray(obj)) {
        obj.forEach(checkObj);
        return;
      }
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (/key|secret|token|credential/i.test(k) && typeof v === "string" && v.length > 8) {
            throw new Error(`Field "${k}" has sensitive-looking value: ${v.slice(0, 10)}...`);
          }
          checkObj(v);
        }
      }
    };
    expect(() => checkObj(parsed)).not.toThrow();
  });
});

// ─── Batch config writing (AC7) ──────────────────────────────────────────────

describe("scanCredentials — batch config writing integration (AC7)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes multiple providers to opencode.json with correct schema", async () => {
    // We import writeOnboardingConfig from onboarding_panel to verify integration
    const { writeOnboardingConfig } = await import("../src/onboarding_panel");
    const { writeBatchConfig } = await import("../src/credential_scanner");

    const credentials: DetectedCredential[] = [
      { provider: "anthropic", key: "sk-ant-batch", source: "env" },
      { provider: "openai", key: "sk-openai-batch", source: "env" },
    ];

    const configPath = path.join(tmpDir, "opencode.json");
    writeBatchConfig(credentials, "anthropic", configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Both providers written
    expect(written.provider.anthropic).toBeDefined();
    expect(written.provider.openai).toBeDefined();

    // Correct schema: options.apiKey (nested), not top-level
    expect(written.provider.anthropic.options.apiKey).toBe("sk-ant-batch");
    expect(written.provider.openai.options.apiKey).toBe("sk-openai-batch");

    // env is string[]
    expect(written.provider.anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(written.provider.openai.env).toEqual(["OPENAI_API_KEY"]);

    // Active model is the default for the selected provider
    expect(written.model).toContain("anthropic/");
  });

  it("uses the selected provider's first model as the active model", async () => {
    const { writeBatchConfig } = await import("../src/credential_scanner");

    const credentials: DetectedCredential[] = [
      { provider: "anthropic", key: "sk-ant", source: "env" },
      { provider: "openai", key: "sk-oi", source: "env" },
    ];

    const configPath = path.join(tmpDir, "opencode.json");
    writeBatchConfig(credentials, "openai", configPath);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Active model should be openai's first model
    expect(written.model).toContain("openai/");
  });
});
