// amicode_service wiring — failure path (#451, M1): a service boot failure
// must return undefined (logged), never throw into activation. Separate file
// because vi.mock is file-hoisted and would replace the real service for the
// happy-path tests too.
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/amicode_service", () => ({
  createAmicodeService: () => ({
    start: () => Promise.reject(new Error("simulated bind failure")),
    authHeader: "Basic should-never-be-reached",
    stop: async () => undefined,
  }),
}));

import { startAmicodeService } from "../src/amicode_service_wiring";

describe("startAmicodeService — failure path", () => {
  it("returns undefined and logs, never throws into activation", async () => {
    const lines: string[] = [];
    const boot = await startAmicodeService({ appendLine: (l) => lines.push(l) });
    expect(boot).toBeUndefined();
    expect(lines.some((l) => l.includes("[amicode-service] boot FAILED"))).toBe(true);
  });
});
