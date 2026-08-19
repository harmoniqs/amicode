// Overture score rewrite tests — Stages 1–2 (#435)
//
// Tests that the rewritten SCORE.md loads, compiles, and that the entity system
// accepts the new `intent` field on the profile entity.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadRepertoire } from "../../src/scores/loader";
import { compileScore, compileChainedScore } from "../../src/scores/compiler";
import { sanitizePayload, appendOnboardingEvent, isOnboardingEntity } from "../../opencode-plugin/onboarding";

const SCORES_ROOT = path.resolve(__dirname, "..", "..", "scores");

function overture() {
  const load = loadRepertoire(SCORES_ROOT);
  const s = load.scores.find((x) => x.manifest.id === "overture");
  if (!s) throw new Error("overture missing from scores repertoire");
  return s;
}

function score0() {
  const load = loadRepertoire(SCORES_ROOT);
  const s = load.scores.find((x) => x.manifest.id === "pulse-designer");
  if (!s) throw new Error("pulse-designer missing from scores repertoire");
  return s;
}

// ─── AC1: Score loads without error ──────────────────────────────────────────

describe("overture SCORE.md — loads and compiles (AC1)", () => {
  it("is discoverable via loadRepertoire", () => {
    const ov = overture();
    expect(ov.manifest.id).toBe("overture");
    expect(ov.manifest.schema_version).toBe(1);
  });

  it("has the new stage structure: orientation, intent, context_seed, demo, environment, devices, goals, handoff", () => {
    const ov = overture();
    const stageIds = ov.manifest.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toContain("orientation");
    expect(stageIds).toContain("intent");
    expect(stageIds).toContain("context_seed");
    expect(stageIds).toContain("demo");
    expect(stageIds).toContain("environment");
    expect(stageIds).toContain("devices");
    expect(stageIds).toContain("goals");
    expect(stageIds).toContain("handoff");
    // Old stage name is gone
    expect(stageIds).not.toContain("platforms");
    expect(stageIds).not.toContain("identity");
  });

  it("compiles to markdown without error (standalone)", () => {
    const md = compileScore(overture());
    expect(md).toBeTruthy();
    expect(md.length).toBeGreaterThan(100);
  });

  it("compiles in chained mode (overture → pulse-designer) without error", () => {
    const md = compileChainedScore(overture(), score0());
    expect(md).toBeTruthy();
    expect(md.length).toBeGreaterThan(200);
  });
});

// ─── AC2-3: Stage 1 orientation content ──────────────────────────────────────

describe("overture compiled content — Stage 1 orientation (AC2, AC3)", () => {
  const md = compileScore(overture());

  it("AC2: introduces Amicode as general coding + research studio, not just QOC", () => {
    // The body should mention general-purpose nature
    expect(md).toContain("coding");
    expect(md).toContain("research");
    // Should NOT frame as solely quantum control
    expect(md).not.toContain("pulse-design copilot");
  });

  it("AC2: does NOT branch by experience level", () => {
    // The score should instruct NOT to branch by experience, not invite branching
    expect(md).not.toContain("have you done");
    expect(md).toContain("Do NOT ask about experience level");
  });

  it("AC3: collects name via question tool", () => {
    expect(md).toContain("name");
    expect(md).toContain('kind: "text"');
  });
});

// ─── AC4-6: Stage 2 intent multi-select ──────────────────────────────────────

describe("overture compiled content — Stage 2 intent (AC4, AC5, AC6)", () => {
  const md = compileScore(overture());

  it("AC4: presents exactly three options for multi-select", () => {
    expect(md).toContain("General coding and software development");
    expect(md).toContain("Research");
    expect(md).toContain("Exploring");
  });

  it("AC4: specifies multiple: true for multi-select", () => {
    expect(md).toContain("multiple: true");
  });

  it("AC5: records intent as array of slugs on the profile entity", () => {
    expect(md).toContain("intent");
    expect(md).toMatch(/intent.*\[.*research.*general_coding.*exploring.*\]/s);
  });

  it("AC6: does NOT ask research sub-type (deferred to pulse-designer)", () => {
    expect(md).toContain("DO NOT ask research sub-type");
    expect(md).not.toContain("Which platform");
    expect(md).not.toContain("qubit platforms");
  });
});

// ─── AC7: one question at a time protocol ────────────────────────────────────

describe("overture compiled content — protocol (AC7)", () => {
  const md = compileScore(overture());

  it("specifies ONE question at a time", () => {
    expect(md).toContain("ONE question at a time");
  });

  it("uses the question tool for all questions", () => {
    expect(md).toContain("question");
  });
});

// ─── AC8: resume logic ───────────────────────────────────────────────────────

describe("overture compiled content — resume (AC8)", () => {
  const md = compileScore(overture());

  it("instructs to check status first and skip already-answered stages", () => {
    expect(md).toContain("amicode_profile");
    expect(md).toContain("status");
    expect(md).toContain("already recorded");
  });
});

// ─── AC9: complete stage flow ────────────────────────────────────────────────

describe("overture compiled content — complete flow (AC9)", () => {
  const md = compileScore(overture());

  it("the overture score is complete: all 8 stages defined end-to-end", () => {
    expect(md).toContain("orientation");
    expect(md).toContain("intent");
    expect(md).toContain("context_seed");
    expect(md).toContain("demo");
    expect(md).toContain("environment");
    expect(md).toContain("goals");
    expect(md).toContain("handoff");
    expect(md).toContain("onboarding_completed");
  });
});

// ─── Intent entity schema — ENTITY_FIELDS extension ──────────────────────────

describe("ENTITY_FIELDS — intent field on profile entity", () => {
  it("profile entity accepts intent field", () => {
    const result = sanitizePayload("profile", {
      name: "JJ",
      intent: ["research", "general_coding"],
    });
    expect(result.name).toBe("JJ");
    expect(result.intent).toEqual(["research", "general_coding"]);
  });

  it("sanitizes secrets in intent values", () => {
    const result = sanitizePayload("profile", {
      intent: ["research", "my-api-key-is-sk-123"],
    });
    // The secret-looking value should be scrubbed
    expect(result.intent).toEqual(["research", "«credential omitted»"]);
  });

  it("appendOnboardingEvent records intent on profile entity", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-intent-"));
    try {
      const { seq, clean } = appendOnboardingEvent(tmpDir, "profile", {
        name: "Test User",
        intent: ["research", "exploring"],
      });
      expect(seq).toBe(1);
      expect(clean.name).toBe("Test User");
      expect(clean.intent).toEqual(["research", "exploring"]);

      // Verify it's in the events.jsonl
      const content = fs.readFileSync(path.join(tmpDir, "events.jsonl"), "utf8");
      expect(content).toContain('"intent"');
      expect(content).toContain('"research"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
