// Handoff routing tests — Stage 8 (#438)
//
// Tests for the single-exit handoff routing, pre-fill resolution,
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

// ─── Handoff routing: one exit path for every intent (#1164) ────────────────

describe("resolveHandoffAction — always a normal new session (#1164)", () => {
  const cases: Array<{ intents: IntentSlug[]; name: string }> = [
    { intents: ["research"], name: "research only" },
    { intents: ["general_coding"], name: "general coding only" },
    { intents: ["exploring"], name: "exploring only" },
    { intents: ["research", "general_coding"], name: "research + general" },
    { intents: ["research", "exploring"], name: "research + exploring" },
    { intents: ["general_coding", "exploring"], name: "general + exploring" },
    { intents: ["research", "general_coding", "exploring"], name: "all three" },
    { intents: [], name: "empty intents" },
  ];

  for (const { intents, name } of cases) {
    it(`${name} → normal-session`, () => {
      const expected: HandoffAction = "normal-session";
      expect(resolveHandoffAction(intents)).toBe(expected);
    });
  }
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
