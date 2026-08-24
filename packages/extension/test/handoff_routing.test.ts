// Handoff routing tests — Stage 8 (#438)
//
// Table-driven tests for the intent-based handoff routing, pre-fill resolution,
// and intent reading from the events stream.

import { describe, it, expect } from "vitest";

import {
  resolveHandoffAction,
  resolvePreFills,
  readIntentFromState,
  type IntentSlug,
  type HandoffAction,
  type SeedState,
} from "../src/handoff_routing";

// ─── AC6: Handoff routing table ─────────────────────────────────────────────

describe("resolveHandoffAction — intent-based routing (AC6)", () => {
  const cases: Array<{ intents: IntentSlug[]; expected: HandoffAction; name: string }> = [
    { intents: ["research"], expected: "research-session", name: "research only → research-session" },
    { intents: ["general_coding"], expected: "normal-session", name: "general coding only → normal-session" },
    { intents: ["exploring"], expected: "tour-session", name: "exploring only → tour-session" },
    { intents: ["research", "general_coding"], expected: "research-session-plus", name: "research + general → research-session-plus" },
    { intents: ["research", "exploring"], expected: "research-session", name: "research + exploring → research-session" },
    { intents: ["general_coding", "exploring"], expected: "normal-session", name: "general + exploring → normal-session" },
    { intents: ["research", "general_coding", "exploring"], expected: "research-session-plus", name: "all three → research-session-plus" },
  ];

  for (const { intents, expected, name } of cases) {
    it(name, () => {
      expect(resolveHandoffAction(intents)).toBe(expected);
    });
  }

  it("empty intents → normal-session (safe default)", () => {
    expect(resolveHandoffAction([])).toBe("normal-session");
  });
});

// ─── AC1-2: Pre-fill resolution ─────────────────────────────────────────────

describe("resolvePreFills — seed-based confirmation prompts (AC1, AC2)", () => {
  it("returns null seeds when no state exists", () => {
    const result = resolvePreFills({});
    expect(result.environmentSeed).toBeNull();
    expect(result.deviceSeed).toBeNull();
  });

  it("AC1: returns environment archetype as seed when available", () => {
    const state: SeedState = {
      environment: { slug: "stanford-qick-lab", archetype: "qick-lab" },
    };
    const result = resolvePreFills(state);
    expect(result.environmentSeed).toBe("qick-lab");
  });

  it("AC1: falls back to slug when archetype is missing", () => {
    const state: SeedState = {
      environment: { slug: "my-lab" },
    };
    const result = resolvePreFills(state);
    expect(result.environmentSeed).toBe("my-lab");
  });

  it("AC2: returns device name + platform as seed", () => {
    const state: SeedState = {
      device: { name: "Emerald-Q3", platform: "transmon" },
    };
    const result = resolvePreFills(state);
    expect(result.deviceSeed).toBe("Emerald-Q3 (transmon)");
  });

  it("AC2: device name only (no platform) works", () => {
    const state: SeedState = {
      device: { name: "MyDevice" },
    };
    const result = resolvePreFills(state);
    expect(result.deviceSeed).toBe("MyDevice");
  });
});

// ─── Intent reading from state ───────────────────────────────────────────────

describe("readIntentFromState — parse intent from profile (AC6)", () => {
  it("returns intent array from profile state", () => {
    const profile = { name: "JJ", intent: ["research", "general_coding"] };
    expect(readIntentFromState(profile)).toEqual(["research", "general_coding"]);
  });

  it("filters out invalid intent values", () => {
    const profile = { intent: ["research", "invalid_thing", "exploring"] };
    expect(readIntentFromState(profile)).toEqual(["research", "exploring"]);
  });

  it("returns empty array when no profile state", () => {
    expect(readIntentFromState(undefined)).toEqual([]);
  });

  it("returns empty array when intent is not an array", () => {
    const profile = { intent: "research" };
    expect(readIntentFromState(profile)).toEqual([]);
  });

  it("returns empty array when intent field is missing", () => {
    const profile = { name: "JJ" };
    expect(readIntentFromState(profile)).toEqual([]);
  });
});

// ─── AC7: Seed rejection (last-write-wins) ───────────────────────────────────

describe("seed rejection semantics (AC7)", () => {
  it("resolvePreFills returns whatever is latest in state (last-write-wins)", () => {
    // If the user overrides a seeded environment, the state will reflect the override
    // because appendOnboardingEvent appends and readOnboardingState replays last-value-wins
    const stateAfterOverride: SeedState = {
      environment: { slug: "user-chosen-env", archetype: "local-sim" },
    };
    const result = resolvePreFills(stateAfterOverride);
    expect(result.environmentSeed).toBe("local-sim");
  });
});
