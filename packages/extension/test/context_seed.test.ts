// Context-seed pipeline tests (#436)
//
// Tests the allowlist scanner, secret redaction, fact extraction,
// size cap, and idempotent seed writing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolveAllowlist,
  readAndRedact,
  scanAllowlistedFiles,
  redactSecrets,
  extractFacts,
  writeSeeds,
  SIZE_CAP,
  type ScanRoot,
  type ScannedFile,
  type SeedPreview,
} from "../src/context_seed";

// ─── AC2, AC10: Allowlist resolution ─────────────────────────────────────────

describe("resolveAllowlist — data-driven path scanning (AC2, AC10)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-scan-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns only files that exist on the allowlist", () => {
    // Stage some files
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Test");
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "rules");
    // "AGENTS.md" is NOT staged

    const allowlist: ScanRoot[] = [
      { root: tmpDir, filenames: ["CLAUDE.md", "AGENTS.md", ".cursorrules"] },
    ];
    const resolved = resolveAllowlist(allowlist);
    expect(resolved).toHaveLength(2);
    expect(resolved).toContain(path.join(tmpDir, "CLAUDE.md"));
    expect(resolved).toContain(path.join(tmpDir, ".cursorrules"));
    expect(resolved).not.toContain(path.join(tmpDir, "AGENTS.md"));
  });

  it("returns empty array when no files exist", () => {
    const allowlist: ScanRoot[] = [
      { root: tmpDir, filenames: ["nonexistent.md"] },
    ];
    expect(resolveAllowlist(allowlist)).toEqual([]);
  });

  it("handles multiple roots", () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "seed-root2-"));
    fs.writeFileSync(path.join(tmpDir, "A.md"), "a");
    fs.writeFileSync(path.join(root2, "B.md"), "b");

    const allowlist: ScanRoot[] = [
      { root: tmpDir, filenames: ["A.md"] },
      { root: root2, filenames: ["B.md"] },
    ];
    const resolved = resolveAllowlist(allowlist);
    expect(resolved).toHaveLength(2);
    fs.rmSync(root2, { recursive: true, force: true });
  });
});

// ─── AC4: Secret redaction ───────────────────────────────────────────────────

describe("redactSecrets — credential removal at read time (AC4)", () => {
  it("redacts sk- prefixed API keys", () => {
    const input = 'api_key = "sk-proj-abc123def456ghi789jkl012mno345"';
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
    expect(result).not.toContain("sk-proj-abc123");
  });

  it("redacts sk-ant- (Anthropic) keys", () => {
    const input = 'key: "sk-ant-api03-very-long-key-value-here-1234567890"';
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
    expect(result).not.toContain("sk-ant-");
  });

  it("redacts AWS access key IDs", () => {
    const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.veryLongTokenValue12345";
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
    expect(result).not.toContain("eyJhbGci");
  });

  it("redacts PEM blocks", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALR\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
    expect(result).not.toContain("MIIBogIBAAJBALR");
  });

  it("redacts key=value patterns with secret-like keys", () => {
    const input = 'api_key: "my-super-secret-key-value-here"';
    const result = redactSecrets(input);
    expect(result).toContain("«credential omitted»");
  });

  it("preserves non-secret content", () => {
    const input = "# My Project\n\nThis is a description of my quantum control project.";
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });
});

// ─── AC3: Size cap ───────────────────────────────────────────────────────────

describe("readAndRedact — size cap (AC3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-cap-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("truncates files exceeding the size cap", () => {
    const largePath = path.join(tmpDir, "large.md");
    // Write content larger than a small cap
    fs.writeFileSync(largePath, "x".repeat(200));
    const result = readAndRedact(largePath, 100);
    expect(result).toBeDefined();
    expect(result!.content.length).toBe(100);
    expect(result!.truncated).toBe(true);
  });

  it("does not truncate files under the cap", () => {
    const smallPath = path.join(tmpDir, "small.md");
    fs.writeFileSync(smallPath, "hello world");
    const result = readAndRedact(smallPath, 1000);
    expect(result).toBeDefined();
    expect(result!.content).toBe("hello world");
    expect(result!.truncated).toBe(false);
  });

  it("returns undefined for non-existent files", () => {
    expect(readAndRedact(path.join(tmpDir, "nope.md"))).toBeUndefined();
  });

  it("applies secret redaction before returning", () => {
    const secretPath = path.join(tmpDir, "secret.md");
    fs.writeFileSync(secretPath, "my_key: AKIAIOSFODNN7EXAMPLE\nother: value");
    const result = readAndRedact(secretPath);
    expect(result!.content).toContain("«credential omitted»");
    expect(result!.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

// ─── AC5: Fact extraction ────────────────────────────────────────────────────

describe("extractFacts — profile and memory card extraction (AC5)", () => {
  it("extracts name from CLAUDE.md with name: pattern", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/CLAUDE.md",
      content: "# Instructions\n\nname: Alice Smith\nrole: Researcher\n",
      truncated: false,
    }];
    const result = extractFacts(files);
    expect(result.profileFacts.some((f) => f.field === "name" && f.value === "Alice Smith")).toBe(true);
    expect(result.profileFacts.some((f) => f.field === "role" && f.value === "Researcher")).toBe(true);
  });

  it("extracts platforms from mentions in content", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/CLAUDE.md",
      content: "I work with transmon qubits and Rydberg atoms.",
      truncated: false,
    }];
    const result = extractFacts(files);
    const platformFact = result.profileFacts.find((f) => f.field === "platforms");
    expect(platformFact).toBeDefined();
    expect(platformFact!.value).toContain("transmon");
  });

  it("extracts project directives as memory cards from .cursorrules", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/.cursorrules",
      content: "- Always use TypeScript strict mode\n- Prefer functional components\n- Use vitest for testing\n",
      truncated: false,
    }];
    const result = extractFacts(files);
    expect(result.memoryCards.length).toBeGreaterThan(0);
    expect(result.memoryCards[0].field).toBe("project_context");
  });

  it("tracks provenance (source file path) on each fact", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/CLAUDE.md",
      content: "name: Bob\n",
      truncated: false,
    }];
    const result = extractFacts(files);
    expect(result.profileFacts[0].source).toBe("/home/user/CLAUDE.md");
  });

  it("returns empty preview for files with no extractable facts", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/empty.md",
      content: "# Generic\n\nNo structured data here.\n",
      truncated: false,
    }];
    const result = extractFacts(files);
    expect(result.profileFacts).toHaveLength(0);
    expect(result.memoryCards).toHaveLength(0);
  });

  it("does not extract «credential omitted» as name", () => {
    const files: ScannedFile[] = [{
      path: "/home/user/CLAUDE.md",
      content: "name: «credential omitted»\n",
      truncated: false,
    }];
    const result = extractFacts(files);
    expect(result.profileFacts.find((f) => f.field === "name")).toBeUndefined();
  });
});

// ─── AC6-7, AC9: Seed writing + idempotency ─────────────────────────────────

describe("writeSeeds — event pipeline writing (AC7, AC9)", () => {
  let tmpDir: string;
  let appendCalls: Array<{ entity: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-write-"));
    appendCalls = [];
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockAppend = (dir: string, entity: string, payload: Record<string, unknown>) => {
    appendCalls.push({ entity, payload });
    return { seq: appendCalls.length };
  };

  it("AC7: writes profile facts via appendOnboardingEvent", () => {
    const preview: SeedPreview = {
      profileFacts: [
        { target: "profile", field: "name", value: "Test User", source: "/a.md" },
        { target: "profile", field: "role", value: "Researcher", source: "/a.md" },
      ],
      memoryCards: [],
    };
    const result = writeSeeds(tmpDir, preview, { profile: true, memory: true }, mockAppend);
    expect(result.count).toBe(1); // merged into one profile event
    expect(appendCalls[0].entity).toBe("profile");
    expect(appendCalls[0].payload).toEqual({ name: "Test User", role: "Researcher" });
  });

  it("AC6: respects group deselection (profile deselected → not written)", () => {
    const preview: SeedPreview = {
      profileFacts: [
        { target: "profile", field: "name", value: "Test", source: "/a.md" },
      ],
      memoryCards: [
        { target: "memory", field: "project_context", value: "stuff", source: "/b.md" },
      ],
    };
    const result = writeSeeds(tmpDir, preview, { profile: false, memory: true }, mockAppend);
    expect(appendCalls.every((c) => c.payload.name === undefined)).toBe(true);
    expect(result.count).toBe(1); // only memory card written
  });

  it("AC6: respects group deselection (memory deselected → not written)", () => {
    const preview: SeedPreview = {
      profileFacts: [
        { target: "profile", field: "name", value: "Test", source: "/a.md" },
      ],
      memoryCards: [
        { target: "memory", field: "project_context", value: "stuff", source: "/b.md" },
      ],
    };
    const result = writeSeeds(tmpDir, preview, { profile: true, memory: false }, mockAppend);
    expect(result.count).toBe(1); // only profile
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].payload.name).toBe("Test");
  });

  it("handles empty preview gracefully", () => {
    const preview: SeedPreview = { profileFacts: [], memoryCards: [] };
    const result = writeSeeds(tmpDir, preview, { profile: true, memory: true }, mockAppend);
    expect(result.count).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ─── AC1, AC11: Opt-in / nothing-found ───────────────────────────────────────

describe("scanAllowlistedFiles — end-to-end scan (AC1, AC11)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-e2e-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AC11: returns empty array when no files exist (nothing found)", () => {
    const allowlist: ScanRoot[] = [{ root: tmpDir, filenames: ["nope.md"] }];
    const result = scanAllowlistedFiles(allowlist);
    expect(result).toEqual([]);
  });

  it("scans multiple files and returns all with content", () => {
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Claude\nname: Alice\n");
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "- rule one\n");

    const allowlist: ScanRoot[] = [
      { root: tmpDir, filenames: ["CLAUDE.md", ".cursorrules"] },
    ];
    const result = scanAllowlistedFiles(allowlist);
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain("Alice");
    expect(result[1].content).toContain("rule one");
  });

  it("secrets are redacted in the returned content", () => {
    fs.writeFileSync(path.join(tmpDir, "config.md"), "token: AKIAIOSFODNN7EXAMPLE\n");

    const allowlist: ScanRoot[] = [
      { root: tmpDir, filenames: ["config.md"] },
    ];
    const result = scanAllowlistedFiles(allowlist);
    expect(result[0].content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result[0].content).toContain("«credential omitted»");
  });
});
