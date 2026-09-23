// remote_session_state.test.ts — #1484 AC4: a Controlled remote session opens
// and interacts in one origin; suspended/revoked peers remain visible/read-only
// with no local fallback.
import { describe, it, expect } from "vitest";
import {
  resolveRemoteSessionState,
  type RemoteSessionState,
  type RemoteSessionDeps,
} from "../src/amicode_service/remote_session_state";

const LOCAL_MACHINE = "local-mac";

function deps(overrides?: Partial<RemoteSessionDeps>): RemoteSessionDeps {
  return {
    localMachineId: LOCAL_MACHINE,
    grantReader: (peerId) => {
      if (peerId === "peer-a") return { scope: "control", state: "active" };
      return undefined;
    },
    peerReachable: (peerId) => peerId === "peer-a",
    ...overrides,
  };
}

describe("#1484 AC4 — remote session state from grant + transport", () => {
  it("local session → 'local' state (interactive)", () => {
    const state = resolveRemoteSessionState("ses-1", LOCAL_MACHINE, deps());
    expect(state.kind).toBe("local");
  });

  it("remote session with active control grant + reachable → 'interactive'", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-a", deps());
    expect(state.kind).toBe("interactive");
    if (state.kind === "interactive") {
      expect(state.machineId).toBe("peer-a");
    }
  });

  it("remote session with NO grant → 'read-only' (visible but no interaction)", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-no-grant", deps());
    expect(state.kind).toBe("read-only");
    if (state.kind === "read-only") {
      expect(state.machineId).toBe("peer-no-grant");
      expect(state.reason).toBe("no-control-grant");
    }
  });

  it("remote session with revoked grant → 'read-only' with reason", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-revoked", deps({
      grantReader: (id) => {
        if (id === "peer-revoked") return { scope: "control", state: "revoked" };
        return undefined;
      },
    }));
    expect(state.kind).toBe("read-only");
    if (state.kind === "read-only") {
      expect(state.reason).toBe("grant-revoked");
    }
  });

  it("remote session with revocation-pending grant → 'suspended' (visible, read-only)", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-pending", deps({
      grantReader: (id) => {
        if (id === "peer-pending") return { scope: "control", state: "revocation-pending" };
        return undefined;
      },
    }));
    expect(state.kind).toBe("suspended");
    if (state.kind === "suspended") {
      expect(state.machineId).toBe("peer-pending");
      expect(state.reason).toBe("revocation-pending");
    }
  });

  it("remote session with observe-only grant → 'read-only'", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-observe", deps({
      grantReader: (id) => {
        if (id === "peer-observe") return { scope: "observe", state: "active" };
        return undefined;
      },
    }));
    expect(state.kind).toBe("read-only");
    if (state.kind === "read-only") {
      expect(state.reason).toBe("insufficient-scope");
    }
  });

  it("remote session with active control but unreachable transport → 'suspended'", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-a", deps({
      peerReachable: () => false,
    }));
    expect(state.kind).toBe("suspended");
    if (state.kind === "suspended") {
      expect(state.reason).toBe("transport-down");
    }
  });
});

describe("#1484 AC4 — no local fallback for known remote sessions", () => {
  it("a known remote session with any degradation NEVER returns local", () => {
    const variants: Array<{ label: string; grantReader: (id: string) => { scope: "control" | "observe"; state: "active" | "revoked" | "revocation-pending" } | undefined }> = [
      { label: "no grant", grantReader: () => undefined },
      { label: "revoked", grantReader: (id) => id === "peer-x" ? { scope: "control", state: "revoked" } : undefined },
      { label: "observe-only", grantReader: (id) => id === "peer-x" ? { scope: "observe", state: "active" } : undefined },
    ];
    for (const { label, grantReader } of variants) {
      const state = resolveRemoteSessionState("ses-1", "peer-x", deps({ grantReader }));
      expect(state.kind, `${label} should not be local`).not.toBe("local");
    }
  });

  it("a remote session state always carries its owner machineId", () => {
    const state = resolveRemoteSessionState("ses-1", "peer-a", deps());
    if (state.kind !== "local") {
      expect(state.machineId).toBe("peer-a");
    }
  });
});
