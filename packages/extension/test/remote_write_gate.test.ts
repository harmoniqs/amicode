// remote_write_gate.test.ts — #1484 AC5: remote file writes require both
// active Control and per-action human confirmation; unavailable owner never
// writes locally.
//
// Binding amendment: remote write confirmation is action-bound and owner-bound.
import { describe, it, expect, vi } from "vitest";
import {
  evaluateRemoteWriteGate,
  type WriteGateResult,
  type WriteGateDeps,
} from "../src/amicode_service/remote_write_gate";

const LOCAL_MACHINE = "local-mac";

function deps(overrides?: Partial<WriteGateDeps>): WriteGateDeps {
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

describe("#1484 AC5 — evaluateRemoteWriteGate enforces Control + confirmation", () => {
  it("local owner → allowed (no confirmation needed for local writes)", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: LOCAL_MACHINE,
      action: "file.write",
      path: "/some/path.ts",
    }, deps());
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
  });

  it("remote owner with active control grant → requires confirmation", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.write",
      path: "/some/path.ts",
    }, deps());
    expect(result.allowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.confirmationContext?.ownerMachineId).toBe("peer-a");
    expect(result.confirmationContext?.action).toBe("file.write");
    expect(result.confirmationContext?.path).toBe("/some/path.ts");
  });

  it("remote owner with NO grant → denied with reason", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-no-grant",
      action: "file.write",
      path: "/some/path.ts",
    }, deps());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no-control-grant");
  });

  it("remote owner with revoked grant → denied", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-revoked",
      action: "file.write",
      path: "/some/path.ts",
    }, deps({
      grantReader: (id) => {
        if (id === "peer-revoked") return { scope: "control", state: "revoked" };
        return undefined;
      },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("grant-revoked");
  });

  it("remote owner with observe-only grant → denied (need control for writes)", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-observe",
      action: "file.write",
      path: "/some/path.ts",
    }, deps({
      grantReader: (id) => {
        if (id === "peer-observe") return { scope: "observe", state: "active" };
        return undefined;
      },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("insufficient-scope");
  });

  it("remote owner with active control but unreachable → denied (transport-down)", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.write",
      path: "/some/path.ts",
    }, deps({
      peerReachable: () => false,
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("transport-down");
  });
});

describe("#1484 AC5 — unavailable owner never writes locally", () => {
  it("a denied write does NOT fall back to local — allowed is false, not redirected", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-no-grant",
      action: "file.write",
      path: "/some/path.ts",
    }, deps());
    expect(result.allowed).toBe(false);
    // There's no 'fallbackLocal' or similar — denied means denied
    expect((result as any).fallbackLocal).toBeUndefined();
  });
});

describe("#1484 AC5 — confirmation is action-bound and owner-bound", () => {
  it("confirmation context carries the specific action (action-bound)", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.delete",
      path: "/some/path.ts",
    }, deps());
    expect(result.confirmationContext?.action).toBe("file.delete");
  });

  it("confirmation context carries the specific owner (owner-bound)", () => {
    const resultA = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.write",
      path: "/path-a.ts",
    }, deps());
    expect(resultA.confirmationContext?.ownerMachineId).toBe("peer-a");
  });

  it("confirmation context carries the specific path", () => {
    const result = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.write",
      path: "/exact/path/to/file.ts",
    }, deps());
    expect(result.confirmationContext?.path).toBe("/exact/path/to/file.ts");
  });

  it("two different actions on the same owner produce distinct confirmation contexts", () => {
    const write = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.write",
      path: "/path.ts",
    }, deps());
    const del = evaluateRemoteWriteGate({
      ownerMachineId: "peer-a",
      action: "file.delete",
      path: "/path.ts",
    }, deps());
    expect(write.confirmationContext?.action).not.toBe(del.confirmationContext?.action);
  });
});
