import { describe, it, expect } from "vitest";
import { shouldSelfExit, type IdlePredicateInput } from "../src/engine_self_shutdown";
import { buildServerSpawnEnv } from "../src/server_auth";

// ============================================================================
// Idle predicate — the pure shouldSelfExit function (#1596)
// ============================================================================

/** Base input where ALL conditions for self-exit hold. */
const allConditionsMet: IdlePredicateInput = {
  msSinceLastPing: 31_000, // > 30s grace
  graceSeconds: 30,
  inFlightTurns: 0,
  activeEventStreamSubscribers: 0,
  roleExempt: false,
};

describe("shouldSelfExit — idle predicate", () => {
  it("returns true when all conditions hold (grace elapsed, no turns, no subscribers, not exempt)", () => {
    expect(shouldSelfExit(allConditionsMet)).toBe(true);
  });

  it("returns false when grace has NOT elapsed", () => {
    expect(shouldSelfExit({ ...allConditionsMet, msSinceLastPing: 29_000 })).toBe(false);
  });

  it("returns false at exactly the grace boundary (not strictly elapsed)", () => {
    // msSinceLastPing === graceSeconds * 1000 is NOT greater-than, so no exit
    expect(shouldSelfExit({ ...allConditionsMet, msSinceLastPing: 30_000 })).toBe(false);
  });

  it("returns false when an in-flight turn is active", () => {
    expect(shouldSelfExit({ ...allConditionsMet, inFlightTurns: 1 })).toBe(false);
  });

  it("returns false when multiple in-flight turns are active", () => {
    expect(shouldSelfExit({ ...allConditionsMet, inFlightTurns: 3 })).toBe(false);
  });

  it("returns false when an active event-stream subscriber exists", () => {
    expect(shouldSelfExit({ ...allConditionsMet, activeEventStreamSubscribers: 1 })).toBe(false);
  });

  it("returns false when role exempt (fleet server/hub)", () => {
    expect(shouldSelfExit({ ...allConditionsMet, roleExempt: true })).toBe(false);
  });

  it("returns false when multiple conditions prevent exit simultaneously", () => {
    expect(
      shouldSelfExit({
        ...allConditionsMet,
        inFlightTurns: 1,
        activeEventStreamSubscribers: 2,
        roleExempt: true,
      }),
    ).toBe(false);
  });
});

// ============================================================================
// Spawn env — AMICO_ENGINE_ROLE_EXEMPT passthrough (#1596)
// ============================================================================

describe("buildServerSpawnEnv — AMICO_ENGINE_ROLE_EXEMPT", () => {
  const baseOpts = {
    amicoRunBinDir: "/fake/bin",
    configContent: "{}",
    serverPassword: "test-pw",
    env: {} as NodeJS.ProcessEnv,
  };

  it("includes AMICO_ENGINE_ROLE_EXEMPT when the env var is set", () => {
    const env = buildServerSpawnEnv({
      ...baseOpts,
      env: { AMICO_ENGINE_ROLE_EXEMPT: "1" } as unknown as NodeJS.ProcessEnv,
    });
    expect(env.AMICO_ENGINE_ROLE_EXEMPT).toBe("1");
  });

  it("does NOT include AMICO_ENGINE_ROLE_EXEMPT when the env var is unset", () => {
    const env = buildServerSpawnEnv({ ...baseOpts, env: {} as NodeJS.ProcessEnv });
    expect(env).not.toHaveProperty("AMICO_ENGINE_ROLE_EXEMPT");
  });
});
