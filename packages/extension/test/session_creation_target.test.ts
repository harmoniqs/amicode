// session_creation_target.test.ts — #1484 AC3: machine picker selection changes
// the actual target for new session creation, not only its displayed state.
//
// The binding amendment rejects cosmetic implementations: picker selection
// changes actual create target.
import { describe, it, expect } from "vitest";
import {
  resolveCreationTarget,
  type CreationTarget,
  type CreationTargetDeps,
} from "../src/amicode_service/session_creation_target";

const LOCAL_MACHINE = "local-mac";

function deps(overrides?: Partial<CreationTargetDeps>): CreationTargetDeps {
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

describe("#1484 AC3 — resolveCreationTarget changes actual target, not only display", () => {
  it("no picker selection (undefined) → local target", () => {
    const target = resolveCreationTarget(undefined, deps());
    expect(target.kind).toBe("local");
  });

  it("picker selects local machine → local target", () => {
    const target = resolveCreationTarget(LOCAL_MACHINE, deps());
    expect(target.kind).toBe("local");
  });

  it("picker selects a remote peer with active control grant → remote target with machineId", () => {
    const target = resolveCreationTarget("peer-a", deps());
    expect(target.kind).toBe("remote");
    if (target.kind === "remote") {
      expect(target.machineId).toBe("peer-a");
    }
  });

  it("picker selects a remote peer with NO grant → blocked with reason", () => {
    const target = resolveCreationTarget("peer-no-grant", deps());
    expect(target.kind).toBe("blocked");
    if (target.kind === "blocked") {
      expect(target.machineId).toBe("peer-no-grant");
      expect(target.reason).toBe("no-control-grant");
    }
  });

  it("picker selects a remote peer with revoked grant → blocked", () => {
    const target = resolveCreationTarget("peer-revoked", deps({
      grantReader: (id) => {
        if (id === "peer-revoked") return { scope: "control", state: "revoked" };
        return undefined;
      },
    }));
    expect(target.kind).toBe("blocked");
    if (target.kind === "blocked") {
      expect(target.reason).toBe("grant-revoked");
    }
  });

  it("picker selects a remote peer with observe-only grant → blocked (need control for creation)", () => {
    const target = resolveCreationTarget("peer-observe", deps({
      grantReader: (id) => {
        if (id === "peer-observe") return { scope: "observe", state: "active" };
        return undefined;
      },
    }));
    expect(target.kind).toBe("blocked");
    if (target.kind === "blocked") {
      expect(target.reason).toBe("insufficient-scope");
    }
  });

  it("picker selects a remote peer with active control but unreachable transport → blocked", () => {
    const target = resolveCreationTarget("peer-a", deps({
      peerReachable: () => false,
    }));
    expect(target.kind).toBe("blocked");
    if (target.kind === "blocked") {
      expect(target.reason).toBe("transport-down");
    }
  });
});

describe("#1484 AC3 — creation target is the ACTUAL dispatch target", () => {
  it("remote target carries the machineId that session creation dispatches to", () => {
    const target = resolveCreationTarget("peer-a", deps());
    expect(target.kind).toBe("remote");
    if (target.kind === "remote") {
      // This is the actual dispatch target — not just a display label
      expect(target.machineId).toBe("peer-a");
      expect(typeof target.machineId).toBe("string");
    }
  });

  it("blocked target carries reason and machineId for user feedback", () => {
    const target = resolveCreationTarget("peer-no-grant", deps());
    expect(target.kind).toBe("blocked");
    if (target.kind === "blocked") {
      expect(target.machineId).toBe("peer-no-grant");
      expect(target.reason).toBeTruthy();
    }
  });
});
