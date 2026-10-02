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

// #1608 AC7: the deliberate off must NARRATE a lifecycle and never strand the
// toggle. `stopping` is pushed BEFORE the kill; the resting `off` is pushed in
// a `finally` so a throwing stop still resolves the UI to a definite state.
describe("stopServer lifecycle narration (#1608 AC7)", () => {
  it("pushes `stopping` before the kill, then `off` after (happy path)", async () => {
    const events: string[] = [];
    const deps: StopServerDeps = {
      stop: vi.fn().mockImplementation(async () => { events.push("stop"); }),
      deleteHandshake: vi.fn().mockImplementation(() => { events.push("deleteHandshake"); }),
      pushState: vi.fn().mockImplementation((s: string) => { events.push(`push:${s}`); }),
    };
    await stopServer(deps);
    // stopping is narrated before the kill; off is the resting state after.
    expect(events).toEqual(["push:stopping", "stop", "deleteHandshake", "push:off"]);
  });

  it("still pushes `off` when stop() throws — the toggle is never stranded on `stopping`", async () => {
    const events: string[] = [];
    const deps: StopServerDeps = {
      stop: vi.fn().mockRejectedValue(new Error("kill failed")),
      deleteHandshake: vi.fn(),
      pushState: vi.fn().mockImplementation((s: string) => { events.push(`push:${s}`); }),
    };
    await expect(stopServer(deps)).rejects.toThrow("kill failed");
    // stopping was narrated, the error propagates, but off was pushed in finally
    // so the UI resolves to a definite state (never stuck on stopping).
    expect(events).toEqual(["push:stopping", "push:off"]);
  });

  it("works without a pushState hook (back-compat — the push is optional)", async () => {
    const deps = makeDeps();
    await expect(stopServer(deps)).resolves.toBeUndefined();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });
});
