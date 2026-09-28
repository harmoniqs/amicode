import { describe, it, expect, vi } from "vitest";
import { planReadoptMode, readoptHubInPlace } from "../src/server_lifecycle";

// ============================================================================
// #1615 (follow-up to #1608): seamless engine toggle-ON for a hub/server window.
//
// The `reclaim-and-readopt` restart plan used to end in a full window reload.
// This makes it re-adopt the launchd-respawned hub IN PLACE — poll the hub
// port, reattach the SSE stream, push `on` — and only falls back to a reload
// when the respawned hub does not answer within the poll budget.
//
// AC1 — planReadoptMode (pure): in-place when the hub answered, reload on timeout.
// AC2 — readoptHubInPlace: reclaim → poll (bounded) → reattach + push on
//        (in-place) OR reload (timeout). Injected deps → no real timers/sockets.
// ============================================================================

describe("planReadoptMode — in-place vs reload decision (#1615 AC1)", () => {
  it("hub answered within budget → in-place-readopt", () => {
    expect(planReadoptMode({ hubAnswered: true })).toBe("in-place-readopt");
  });

  it("hub did NOT answer (poll budget elapsed) → reload-readopt (safe fallback)", () => {
    expect(planReadoptMode({ hubAnswered: false })).toBe("reload-readopt");
  });
});

describe("readoptHubInPlace — the seamless re-adopt routine (#1615 AC2)", () => {
  const baseDeps = () => {
    const calls: string[] = [];
    return {
      calls,
      port: 4096,
      reclaimPort: vi.fn(async () => {
        calls.push("reclaim");
        return true;
      }),
      // poll returns the ready URL when the respawned hub answers, or undefined
      // on timeout. The routine must AWAIT reclaim before the first poll.
      pollHub: vi.fn(async () => {
        calls.push("poll");
        return "http://127.0.0.1:4096";
      }),
      reattachSse: vi.fn((url: string) => {
        calls.push(`reattach:${url}`);
      }),
      pushEngineState: vi.fn((s: string) => {
        calls.push(`push:${s}`);
      }),
      reloadWindow: vi.fn(() => {
        calls.push("reload");
      }),
      deleteHandshake: vi.fn(() => {
        calls.push("delete");
      }),
      log: undefined,
    };
  };

  it("in-place path: reclaim → poll → reattach → push on; NO reload", async () => {
    const d = baseDeps();
    await readoptHubInPlace(d);
    // reclaim must precede the poll (launchd respawns only after the port frees)
    expect(d.calls[0]).toBe("reclaim");
    expect(d.calls).toContain("poll");
    expect(d.reattachSse).toHaveBeenCalledWith("http://127.0.0.1:4096");
    expect(d.pushEngineState).toHaveBeenCalledWith("on");
    expect(d.reloadWindow).not.toHaveBeenCalled();
  });

  it("timeout path: hub never answers → falls back to reload (never a stuck grey)", async () => {
    const d = baseDeps();
    d.pollHub = vi.fn(async () => {
      d.calls.push("poll");
      return undefined; // budget elapsed, hub still down
    });
    await readoptHubInPlace(d);
    expect(d.reattachSse).not.toHaveBeenCalled();
    // on timeout we still delete the handshake + reload, mirroring the old path
    expect(d.deleteHandshake).toHaveBeenCalled();
    expect(d.reloadWindow).toHaveBeenCalled();
  });

  it("never reattaches AND reloads (the two outcomes are exclusive)", async () => {
    const d = baseDeps();
    await readoptHubInPlace(d);
    expect(d.reattachSse).toHaveBeenCalledTimes(1);
    expect(d.reloadWindow).not.toHaveBeenCalled();
  });

  it("reclaim runs before poll even when reclaim reports the port not freed", async () => {
    const d = baseDeps();
    d.reclaimPort = vi.fn(async () => {
      d.calls.push("reclaim");
      return false; // could not confirm freed — poll still proceeds (gate re-probes)
    });
    await readoptHubInPlace(d);
    expect(d.calls[0]).toBe("reclaim");
    expect(d.calls).toContain("poll");
  });
});
