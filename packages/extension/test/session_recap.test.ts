// Tests for the session_recap module — the pure/testable layer.
//
// The DB-access layer (bun:sqlite) is not available under vitest/Node, so
// buildRecentSessionsBlock() itself is tested only as "returns null when
// bun:sqlite is unavailable" (graceful degradation). The logic it orchestrates
// — filtering, outcome extraction, recap composition, caching, markdown — is
// all exercised here through the exported pure functions.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  filterCandidates,
  extractOutcomes,
  composeRecapText,
  composeMarkdown,
  readCachedRecap,
  writeCachedRecap,
  buildRecentSessionsBlock,
  NOISE_TITLE_PREFIXES,
  MIN_ASSISTANT_MESSAGES,
  MAX_RECAPS,
  type SessionRow,
  type SessionRecap,
} from "../opencode-plugin/session_recap";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: `ses_${Math.random().toString(36).slice(2)}`,
    title: "Test session",
    parent_id: null,
    time_created: Date.now() - 3600_000,
    time_updated: Date.now(),
    ...overrides,
  };
}

// ── filterCandidates ─────────────────────────────────────────────────────────

describe("filterCandidates — session selection logic", () => {
  const alwaysEnough = () => MIN_ASSISTANT_MESSAGES;
  const alwaysTooFew = () => MIN_ASSISTANT_MESSAGES - 1;

  it("excludes the current session", () => {
    const s = makeSession({ id: "ses_current" });
    const result = filterCandidates([s], "ses_current", alwaysEnough);
    expect(result).toHaveLength(0);
  });

  it("excludes sessions with noise title prefixes", () => {
    const sessions = NOISE_TITLE_PREFIXES.map(p =>
      makeSession({ title: `${p} of old messages` }),
    );
    const result = filterCandidates(sessions, undefined, alwaysEnough);
    expect(result).toHaveLength(0);
  });

  it("excludes sessions with too few assistant messages", () => {
    const s = makeSession();
    const result = filterCandidates([s], undefined, alwaysTooFew);
    expect(result).toHaveLength(0);
  });

  it("includes sessions meeting all criteria", () => {
    const s = makeSession({ title: "Transmon X gate design" });
    const result = filterCandidates([s], undefined, alwaysEnough);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(s.id);
  });

  it("caps at MAX_RECAPS", () => {
    const sessions = Array.from({ length: MAX_RECAPS + 5 }, (_, i) =>
      makeSession({ id: `ses_${i}`, title: `Session ${i}` }),
    );
    const result = filterCandidates(sessions, undefined, alwaysEnough);
    expect(result).toHaveLength(MAX_RECAPS);
  });

  it("does not exclude sessions with null currentSessionId", () => {
    const s = makeSession();
    const result = filterCandidates([s], undefined, alwaysEnough);
    expect(result).toHaveLength(1);
  });
});

// ── extractOutcomes ──────────────────────────────────────────────────────────

describe("extractOutcomes — numerical result extraction from assistant text", () => {
  it("extracts fidelity values (F=0.9xxx)", () => {
    const texts = ["The solve converged to F = 0.99982 in 137 iterations."];
    const outcomes = extractOutcomes(texts);
    expect(outcomes).toContain("F=0.99982");
  });

  it("extracts iteration counts", () => {
    const texts = ["Converged after 250 iterations."];
    const outcomes = extractOutcomes(texts);
    expect(outcomes).toContain("250 iterations");
  });

  it("extracts infidelity in scientific notation", () => {
    const texts = ["infidelity = 2.1e-4 after smoothing."];
    const outcomes = extractOutcomes(texts);
    expect(outcomes).toContain("infidelity 2.1e-4");
  });

  it("deduplicates: only first fidelity is kept", () => {
    const texts = [
      "First run: F = 0.998",
      "Second run: F = 0.9995",
    ];
    const outcomes = extractOutcomes(texts);
    const fEntries = outcomes.filter(o => o.startsWith("F="));
    expect(fEntries).toHaveLength(1);
    expect(fEntries[0]).toBe("F=0.998");
  });

  it("returns empty for text with no numerical outcomes", () => {
    const texts = ["Let me help you set up the system model."];
    const outcomes = extractOutcomes(texts);
    expect(outcomes).toHaveLength(0);
  });

  it("handles empty input", () => {
    expect(extractOutcomes([])).toEqual([]);
  });
});

// ── composeRecapText ─────────────────────────────────────────────────────────

describe("composeRecapText — recap string composition", () => {
  it("returns first user prompt truncated to 120 chars", () => {
    const longPrompt = "x".repeat(200);
    const result = composeRecapText([longPrompt], []);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(120 + 10); // prompt + possible suffix
  });

  it("appends turn count for multi-turn sessions", () => {
    const result = composeRecapText(["first", "second", "third"], []);
    expect(result).toContain("+2 more turns");
  });

  it("appends outcomes when present", () => {
    const result = composeRecapText(["Design X gate"], ["F=0.999", "50 iterations"]);
    expect(result).toContain("F=0.999, 50 iterations");
  });

  it("returns null for empty user texts", () => {
    expect(composeRecapText([], ["F=0.999"])).toBeNull();
  });

  it("replaces newlines in prompts with spaces", () => {
    const result = composeRecapText(["line1\nline2\nline3"], []);
    expect(result).not.toContain("\n");
  });
});

// ── composeMarkdown ──────────────────────────────────────────────────────────

describe("composeMarkdown — final prompt section composition", () => {
  it("starts with the heading", () => {
    const recaps: SessionRecap[] = [{
      session_id: "ses_1",
      title: "Test",
      created: "2026-08-23T10:30:00.000Z",
      recap: "Did some stuff",
      summarized_at: "2026-08-23T14:00:00.000Z",
    }];
    const md = composeMarkdown(recaps);
    expect(md.startsWith("## Recent sessions (last 7 days)")).toBe(true);
  });

  it("renders date and time for each entry", () => {
    const recaps: SessionRecap[] = [{
      session_id: "ses_1",
      title: "Transmon X gate",
      created: "2026-08-23T10:30:00.000Z",
      recap: "Launched solve, F=0.999",
      summarized_at: "2026-08-23T14:00:00.000Z",
    }];
    const md = composeMarkdown(recaps);
    expect(md).toContain("Aug 23");
    expect(md).toContain("Launched solve, F=0.999");
  });

  it("renders title in bold when not 'New Session'", () => {
    const recaps: SessionRecap[] = [{
      session_id: "ses_1",
      title: "CZ gate design",
      created: "2026-08-22T09:00:00.000Z",
      recap: "Started interview",
      summarized_at: "2026-08-22T09:05:00.000Z",
    }];
    const md = composeMarkdown(recaps);
    expect(md).toContain("**CZ gate design**");
  });

  it("omits title when it is 'New Session'", () => {
    const recaps: SessionRecap[] = [{
      session_id: "ses_1",
      title: "New Session",
      created: "2026-08-22T09:00:00.000Z",
      recap: "Quick question",
      summarized_at: "2026-08-22T09:05:00.000Z",
    }];
    const md = composeMarkdown(recaps);
    expect(md).not.toContain("**New Session**");
    expect(md).toContain("Quick question");
  });

  it("renders multiple entries in order", () => {
    const recaps: SessionRecap[] = [
      { session_id: "ses_1", title: "First", created: "2026-08-23T10:00:00.000Z", recap: "A", summarized_at: "" },
      { session_id: "ses_2", title: "Second", created: "2026-08-22T10:00:00.000Z", recap: "B", summarized_at: "" },
    ];
    const md = composeMarkdown(recaps);
    const posA = md.indexOf("A");
    const posB = md.indexOf("B");
    expect(posA).toBeLessThan(posB);
  });
});

// ── Cache read/write ─────────────────────────────────────────────────────────

describe("cache — read/write SessionRecap to disk", () => {
  let tmpDir: string;
  const origEnv = process.env.AMICODE_SESSION_RECAP_CACHE_DIR;

  beforeEach(() => {
    tmpDir = mkTmp("recap-cache-");
    process.env.AMICODE_SESSION_RECAP_CACHE_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AMICODE_SESSION_RECAP_CACHE_DIR;
    else process.env.AMICODE_SESSION_RECAP_CACHE_DIR = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips a recap through write then read", () => {
    const recap: SessionRecap = {
      session_id: "ses_test123",
      title: "My session",
      created: "2026-08-23T10:00:00.000Z",
      recap: "Tested the thing",
      summarized_at: "2026-08-23T14:00:00.000Z",
    };
    writeCachedRecap(recap);
    const read = readCachedRecap("ses_test123");
    expect(read).toEqual(recap);
  });

  it("returns null for uncached session", () => {
    expect(readCachedRecap("ses_nonexistent")).toBeNull();
  });

  it("write is atomic (uses tmp + rename)", () => {
    const recap: SessionRecap = {
      session_id: "ses_atomic",
      title: "Atomic",
      created: "2026-08-23T10:00:00.000Z",
      recap: "Test",
      summarized_at: "2026-08-23T14:00:00.000Z",
    };
    writeCachedRecap(recap);
    // No .tmp file should remain
    const files = fs.readdirSync(tmpDir);
    expect(files.some(f => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain("ses_atomic.json");
  });
});

// ── buildRecentSessionsBlock graceful degradation ────────────────────────────

describe("buildRecentSessionsBlock — graceful degradation under Node (no bun:sqlite)", () => {
  it("returns null when bun:sqlite is unavailable (Node runtime)", () => {
    // Under vitest/Node, bun:sqlite doesn't load — the function should
    // degrade gracefully and return null.
    const result = buildRecentSessionsBlock("ses_current");
    expect(result).toBeNull();
  });
});
