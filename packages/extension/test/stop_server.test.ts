// stop_server.test.ts — #1149 / #1598: Stop-server command tests.
// The deliberate kill: stop() → deleteHandshake(), with NO confirmation.
// (#1598 removed the in-flight-turns warning: its only predicate was SSE
// stream liveness, true whenever the engine is healthy, so it nagged on
// essentially every stop. A deliberate toggle needs no prompt.)
import { describe, it, expect, vi } from "vitest";
import { stopServer, type StopServerDeps } from "../src/stop_server";

function makeDeps(overrides?: Partial<StopServerDeps>): StopServerDeps {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
    deleteHandshake: vi.fn(),
    ...overrides,
  };
}

describe("stopServer (#1149, #1598)", () => {
  it("stops and deletes the handshake with no confirmation", async () => {
    const deps = makeDeps();
    await stopServer(deps);

    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
  });

  it("deletes the handshake AFTER the kill (no stale record survives)", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      stop: vi.fn().mockImplementation(async () => {
        order.push("stop");
      }),
      deleteHandshake: vi.fn().mockImplementation(() => {
        order.push("deleteHandshake");
      }),
    });
    await stopServer(deps);

    expect(order).toEqual(["stop", "deleteHandshake"]);
  });

  it("propagates a stop() rejection without deleting the handshake", async () => {
    const deps = makeDeps({
      stop: vi.fn().mockRejectedValue(new Error("kill failed")),
    });

    await expect(stopServer(deps)).rejects.toThrow("kill failed");
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
  });
});
