// stop_server.test.ts — #1149: Stop-server command tests.
// Covers: stop with no turns, stop with turns (confirm + cancel),
// and the handshake deletion invariant.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { stopServer, type StopServerDeps } from "../src/stop_server";

function makeDeps(overrides?: Partial<StopServerDeps>): StopServerDeps {
  return {
    hasInFlightTurns: () => false,
    showWarning: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deleteHandshake: vi.fn(),
    ...overrides,
  };
}

describe("stopServer (#1149)", () => {
  it("stops and deletes handshake when no in-flight turns", async () => {
    const deps = makeDeps();
    await stopServer(deps);

    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
  });

  it("warns and stops when in-flight turns exist and user confirms", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue("Stop"),
    });
    await stopServer(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    // Verify the warning message mentions in-flight turns
    const msg = (deps.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/in.flight/i);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
  });

  it("does NOT stop when in-flight turns exist and user cancels", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue("Cancel"),
    });
    await stopServer(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
  });

  it("does NOT stop when in-flight turns exist and user dismisses", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue(undefined), // dismissed
    });
    await stopServer(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
  });
});
