// #2180: the hermetic per-file setup clears ambient AMICO*/AMICODE*/OPENCODE*
// vars so the local suite matches CI. It must NOT clear AMICO_TEST_JULIA_PROJECT:
// that var is the explicit opt-in that lets the slow Julia template suites run,
// and clearing it made them skip silently on every machine.
import { describe, it, expect } from "vitest";
import { isHermeticallyCleared } from "./hermetic_env";

describe("hermetic test env (#2180)", () => {
  it("preserves AMICO_TEST_JULIA_PROJECT so the slow Julia suites can run", () => {
    expect(isHermeticallyCleared("AMICO_TEST_JULIA_PROJECT")).toBe(false);
  });

  it.each([
    "AMICO_FLEET_MULTIPLEX",
    "AMICO_TEST_REHEARSAL_PROJECT",
    "AMICODE_SERVICE_AUTH",
    "AMICODE_ENGINE_UNARMED",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE",
  ])("still clears %s", (key) => {
    expect(isHermeticallyCleared(key)).toBe(true);
  });

  it("leaves unrelated vars alone", () => {
    expect(isHermeticallyCleared("PATH")).toBe(false);
    expect(isHermeticallyCleared("HOME")).toBe(false);
  });
});
