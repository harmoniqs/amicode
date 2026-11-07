import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushEngineState, pushFleetRole, type EngineState } from "../src/engine_state_push";
import { ChatPanel } from "../src/chat_panel";

// ============================================================================
// #1598: engine lifecycle state push — the extension→app channel that drives
// the engine on/off toggle. The toggle MUST render from these pushes, never
// from the engine's own status surface (which 503s when down).
// ============================================================================

describe("pushEngineState (#1598)", () => {
  let posted: unknown[];

  beforeEach(() => {
    posted = [];
    vi.spyOn(ChatPanel, "postToAll").mockImplementation((msg) => {
      posted.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the correct message shape for each engine state", () => {
    const states: EngineState[] = ["on", "booting", "off"];
    for (const state of states) {
      posted.length = 0;
      pushEngineState(state);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toEqual({
        source: "amicode",
        kind: "engine-state",
        state,
      });
    }
  });

  it("broadcasts to all panels via ChatPanel.postToAll", () => {
    pushEngineState("on");
    expect(ChatPanel.postToAll).toHaveBeenCalledTimes(1);
  });
});

describe("pushFleetRole (#1598)", () => {
  let posted: unknown[];

  beforeEach(() => {
    posted = [];
    vi.spyOn(ChatPanel, "postToAll").mockImplementation((msg) => {
      posted.push(msg);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts role from an ok topology", () => {
    pushFleetRole({
      kind: "ok",
      role: "server",
      mode: "fleet",
      posture: "active",
      freshness: {},
      provenanceSource: "test",
      projection: {} as any,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      source: "amicode",
      kind: "fleet-role",
      role: "server",
    });
  });

  it("posts 'standalone' for a client topology", () => {
    pushFleetRole({
      kind: "ok",
      role: "client",
      mode: "fleet",
      posture: "active",
      freshness: {},
      provenanceSource: "test",
      projection: {} as any,
    });
    expect(posted[0]).toEqual({
      source: "amicode",
      kind: "fleet-role",
      role: "client",
    });
  });

  it("defaults to 'standalone' when topology is absent/broken", () => {
    pushFleetRole({ kind: "absent", detail: "test" });
    expect(posted[0]).toEqual({
      source: "amicode",
      kind: "fleet-role",
      role: "standalone",
    });
  });
});
