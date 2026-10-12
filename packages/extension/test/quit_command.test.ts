// quit_command.test.ts — #1597 / #1598: Amicode: Quit command tests.
// The "I'm done" action: stop() → deleteHandshake() → closeWindow(), with
// NO confirmation. (#1598 removed the in-flight-turns warning — its only
// predicate was SSE stream liveness, true whenever the engine is healthy,
// so it nagged on essentially every quit.)
import { describe, it, expect, vi } from "vitest";
import { quitAmicode, type QuitDeps } from "../src/quit_command";

function makeDeps(overrides?: Partial<QuitDeps>): QuitDeps {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
    deleteHandshake: vi.fn(),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("quitAmicode (#1597, #1598)", () => {
  it("stops, deletes the handshake, and closes the window with no confirmation", async () => {
    const deps = makeDeps();
    await quitAmicode(deps);

    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("calls stop BEFORE closeWindow (ordering invariant)", async () => {
    // The load-bearing behavior: stop must precede closeWindow.
    // If closeWindow fires first, deactivate's detach() runs (not kill),
    // stranding the engine until the idle timer fires.
    const order: string[] = [];
    const deps = makeDeps({
      stop: vi.fn(async () => {
        order.push("stop");
      }),
      deleteHandshake: vi.fn(() => {
        order.push("deleteHandshake");
      }),
      closeWindow: vi.fn(async () => {
        order.push("closeWindow");
      }),
    });
    await quitAmicode(deps);

    expect(order).toEqual(["stop", "deleteHandshake", "closeWindow"]);
  });

  it("does NOT close the window if stop() rejects (engine must die first)", async () => {
    const deps = makeDeps({
      stop: vi.fn().mockRejectedValue(new Error("kill failed")),
    });

    await expect(quitAmicode(deps)).rejects.toThrow("kill failed");
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
    expect(deps.closeWindow).not.toHaveBeenCalled();
  });
});
