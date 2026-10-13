// remote_session_state.test.ts — #1484 AC4: a Controlled remote session opens
// and interacts in one origin; suspended/revoked peers remain visible/read-only
// with no local fallback.
import { describe, it, expect } from "vitest";
import {
  resolveRemoteSessionState,
  projectSessionControlState,
  buildControlResolver,
  CONTROL_CHIP_REASONS,
  type RemoteSessionState,
  type RemoteSessionDeps,
  type SessionControlProjection,
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

// ── #1544 (slice 4) — the state channel Data Contract ─────────────────────────
// `projectSessionControlState` is the SINGLE SOURCE OF TRUTH projector for the
// app-visible control shape { controlState, reason, eligibility } carried on the
// fleet projection (GET /amicode/fleet/sessions). It projects from the
// remote_session_state kind + reason — NOT the raw write-gate reason (the write
// gate COLLAPSES revocation-pending→grant-revoked; this projector must keep them
// distinct, so the fail-closed chip can say which). Eligibility is derived from
// ownership (self vs shared) + whether control is currently held.
describe("#1544 projectSessionControlState — the app-visible { controlState, reason, eligibility }", () => {
  it("enumerates EXACTLY the five reasons the SoT emits (no more, no fewer)", () => {
    expect([...CONTROL_CHIP_REASONS].sort()).toEqual(
      ["grant-revoked", "insufficient-scope", "no-control-grant", "revocation-pending", "transport-down"],
    );
  });

  it("local → controlState local, no reason, no affordance", () => {
    const p = projectSessionControlState({ kind: "local" }, { selfOwned: true });
    expect(p).toEqual({ controlState: "local", reason: null, eligibility: "none" } satisfies SessionControlProjection);
  });

  it("interactive (control held) → no chip reason, no enable/request affordance", () => {
    const p = projectSessionControlState({ kind: "interactive", machineId: "peer-a" }, { selfOwned: true });
    expect(p).toEqual({ controlState: "interactive", reason: null, eligibility: "none" });
  });

  it("read-only no-control-grant, self-owned → Enable-control affordance, chip reason preserved", () => {
    const p = projectSessionControlState(
      { kind: "read-only", machineId: "peer-a", reason: "no-control-grant" },
      { selfOwned: true },
    );
    expect(p).toEqual({ controlState: "read-only", reason: "no-control-grant", eligibility: "enable-control" });
  });

  it("read-only no-control-grant, SHARED peer → Request-control affordance", () => {
    const p = projectSessionControlState(
      { kind: "read-only", machineId: "peer-a", reason: "no-control-grant" },
      { selfOwned: false },
    );
    expect(p.eligibility).toBe("request-control");
    expect(p.reason).toBe("no-control-grant");
  });

  it("read-only insufficient-scope / grant-revoked preserve their distinct reasons", () => {
    expect(projectSessionControlState({ kind: "read-only", machineId: "p", reason: "insufficient-scope" }, { selfOwned: true }).reason).toBe("insufficient-scope");
    expect(projectSessionControlState({ kind: "read-only", machineId: "p", reason: "grant-revoked" }, { selfOwned: true }).reason).toBe("grant-revoked");
  });

  it("suspended revocation-pending stays DISTINCT from grant-revoked (the SoT distinction the write gate collapses)", () => {
    const pending = projectSessionControlState(
      { kind: "suspended", machineId: "peer-a", reason: "revocation-pending" },
      { selfOwned: true },
    );
    expect(pending.controlState).toBe("suspended");
    expect(pending.reason).toBe("revocation-pending");
    // and it is still eligible to re-enable (self-owned)
    expect(pending.eligibility).toBe("enable-control");
  });

  it("suspended transport-down → suspended state, transport-down reason, eligible to re-enable", () => {
    const p = projectSessionControlState(
      { kind: "suspended", machineId: "peer-a", reason: "transport-down" },
      { selfOwned: true },
    );
    expect(p).toEqual({ controlState: "suspended", reason: "transport-down", eligibility: "enable-control" });
  });
});

describe("#1544 buildControlResolver — the projection carrier's per-owner resolver (route wiring)", () => {
  const resolver = buildControlResolver({
    localMachineId: "local-mac",
    grantReader: (id) => (id === "peer-a" ? { scope: "control", state: "active" } : undefined),
    peerReachable: (id) => id === "peer-a",
    isSelfOwned: () => true,
  });

  it("resolves a local entry to controlState local", () => {
    expect(resolver("local-mac", true)).toEqual({ controlState: "local", reason: null, eligibility: "none" });
  });

  it("resolves a controlled+reachable peer to interactive", () => {
    expect(resolver("peer-a", false)).toEqual({ controlState: "interactive", reason: null, eligibility: "none" });
  });

  it("resolves an ungranted peer to read-only + no-control-grant + enable-control", () => {
    expect(resolver("peer-b", false)).toEqual({
      controlState: "read-only",
      reason: "no-control-grant",
      eligibility: "enable-control",
    });
  });
});
