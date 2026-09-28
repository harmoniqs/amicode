// quit_command.test.ts — #1597: Amicode: Quit command tests.
// Covers: quit with no turns, quit with turns (confirm + cancel + dismiss),
// and the stop-before-close ordering invariant.
import { describe, it, expect, vi } from "vitest";
import { quitAmicode, type QuitDeps } from "../src/quit_command";

function makeDeps(overrides?: Partial<QuitDeps>): QuitDeps {
  return {
    hasInFlightTurns: () => false,
    showWarning: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deleteHandshake: vi.fn(),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("quitAmicode (#1597)", () => {
  it("stops, deletes handshake, and closes window when no in-flight turns", async () => {
    const deps = makeDeps();
    await quitAmicode(deps);

    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("warns and quits when in-flight turns exist and user confirms", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue("Quit"),
    });
    await quitAmicode(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    // Verify the warning message mentions in-flight turns
    const msg = (deps.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/in.flight/i);
    expect(deps.stop).toHaveBeenCalledTimes(1);
    expect(deps.deleteHandshake).toHaveBeenCalledTimes(1);
    expect(deps.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("does NOT quit when in-flight turns exist and user cancels", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue("Cancel"),
    });
    await quitAmicode(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
    expect(deps.closeWindow).not.toHaveBeenCalled();
  });

  it("does NOT quit when in-flight turns exist and user dismisses", async () => {
    const deps = makeDeps({
      hasInFlightTurns: () => true,
      showWarning: vi.fn().mockResolvedValue(undefined), // dismissed
    });
    await quitAmicode(deps);

    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.deleteHandshake).not.toHaveBeenCalled();
    expect(deps.closeWindow).not.toHaveBeenCalled();
  });

  it("calls stop BEFORE closeWindow (ordering invariant)", async () => {
    // The load-bearing behavior: stop must precede closeWindow.
    // If closeWindow fires first, deactivate's detach() runs (not kill),
    // stranding the engine until the idle timer fires.
    const order: string[] = [];
    const deps = makeDeps({
      stop: vi.fn(async () => { order.push("stop"); }),
      deleteHandshake: vi.fn(() => { order.push("deleteHandshake"); }),
      closeWindow: vi.fn(async () => { order.push("closeWindow"); }),
    });
    await quitAmicode(deps);

    expect(order).toEqual(["stop", "deleteHandshake", "closeWindow"]);
  });
});
