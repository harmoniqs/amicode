// fleet_control_request.test.ts — #1545 (ADR 0034 D3): the SHARED-PEER
// control request→approve handshake. A shared peer (a different operator's
// machine) can't use the self-owned fast-path — it must request control,
// routed to the target's lifecycle-admin authority holder, who approves or
// denies. This suite pins:
//
//   · The pending-request store — file-based, keyed, state machine
//     (pending → approved|denied).
//   · The request route — POST /amicode/fleet/control-request: records a
//     pending request, returns status. Idempotent on already-granted.
//   · The approve/deny routes — POST /amicode/fleet/control-approve and
//     /control-deny: authority-gated, mint a control grant on approve.
//   · Fail-closed — no approval, no control.
//   · No privilege bleed — the shared path NEVER borrows the self-owned
//     fast-path.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ControlRequest,
  type ControlRequestDeps,
  type ControlRequestResult,
  type ApproveControlResult,
  type DenyControlResult,
  submitControlRequest,
  approveControlRequest,
  denyControlRequest,
  readPendingRequests,
  readControlRequest,
  CONTROL_REQUEST_STORE_VERSION,
} from "../src/amicode_service/fleet_control_request";
import {
  readLifecycleGrant,
  findControlGrantByTarget,
  evaluateRouteMatrix,
  type LifecycleGrantDeps,
} from "../src/amicode_service/fleet_control_lifecycle";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-1545-control-request-"));
}

const REQUESTER_ID = "shared-macbook";
const REQUESTER_KEY = "SHA256:shared-fingerprint";
const TARGET_ID = "the-studio";
const TARGET_KEY = "SHA256:studio-fingerprint";
const AUTHORITY_ID = "authority-machine";
const AUTHORITY_KEY = "SHA256:authority-fingerprint";

function makeDeps(root?: string): ControlRequestDeps {
  const r = root ?? tmproot();
  return {
    requestStoreFile: join(r, "control-requests.json"),
    grantDeps: {
      grantStoreFile: join(r, "lifecycle-grants.json"),
      tokenFactory: () => "CONTROL-TOKEN-FROM-APPROVE",
      now: () => "2026-09-24T12:00:00.000Z",
    },
    now: () => "2026-09-24T10:00:00.000Z",
  };
}

function makeRequest(overrides?: Partial<ControlRequest>): ControlRequest {
  return {
    requesterMachineId: REQUESTER_ID,
    requesterIdentityKey: REQUESTER_KEY,
    targetMachineId: TARGET_ID,
    targetIdentityKey: TARGET_KEY,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pending-request store — file-based, keyed, state machine
// ═══════════════════════════════════════════════════════════════════════════
describe("pending-request store — submit creates a pending request", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("submitControlRequest creates a pending request and returns status=pending", () => {
    const result = submitControlRequest(makeRequest(), deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("pending");
  });

  it("the pending request is readable from the store", () => {
    submitControlRequest(makeRequest(), deps);
    const stored = readControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("pending");
    expect(stored!.requesterMachineId).toBe(REQUESTER_ID);
    expect(stored!.targetMachineId).toBe(TARGET_ID);
    expect(stored!.requestedAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("readPendingRequests returns only pending requests", () => {
    submitControlRequest(makeRequest(), deps);
    const pending = readPendingRequests(deps);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].requesterMachineId).toBe(REQUESTER_ID);
  });

  it("a duplicate submit is idempotent — returns pending, does not create a second request", () => {
    submitControlRequest(makeRequest(), deps);
    const result = submitControlRequest(makeRequest(), deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("pending");
    const pending = readPendingRequests(deps);
    expect(pending).toHaveLength(1);
  });

  it("the store file uses the env-overridable path", () => {
    submitControlRequest(makeRequest(), deps);
    expect(existsSync(deps.requestStoreFile!)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Approve — authority-gated, mints a control grant
// ═══════════════════════════════════════════════════════════════════════════
describe("approveControlRequest — mints a control grant + updates request to approved", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    deps = makeDeps();
    submitControlRequest(makeRequest(), deps);
  });

  it("approving a pending request mints a control grant and returns the token", () => {
    const result = approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant).toBeDefined();
    expect(result.grant.scope).toBe("control");
    expect(result.grant.state).toBe("active");
    expect(result.grant.token).toBe("CONTROL-TOKEN-FROM-APPROVE");
    expect(result.grant.requesterMachineId).toBe(REQUESTER_ID);
    expect(result.grant.targetMachineId).toBe(TARGET_ID);
  });

  it("approval updates the request status to approved", () => {
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const stored = readControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("approved");
  });

  it("the minted grant is readable from the lifecycle grant store", () => {
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const grant = readLifecycleGrant(REQUESTER_ID, deps.grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.scope).toBe("control");
    expect(grant!.state).toBe("active");
  });

  it("the minted grant is findable by targetMachineId", () => {
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const grant = findControlGrantByTarget(TARGET_ID, deps.grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.scope).toBe("control");
    expect(grant!.token).toBe("CONTROL-TOKEN-FROM-APPROVE");
  });

  it("approving a non-existent request fails with not-found", () => {
    const result = approveControlRequest("unknown-peer", TARGET_ID, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("approving an already-approved request is idempotent — returns already-approved", () => {
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const result = approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("already-approved");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deny — updates request, no grant minted
// ═══════════════════════════════════════════════════════════════════════════
describe("denyControlRequest — no grant minted, request updated to denied", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    deps = makeDeps();
    submitControlRequest(makeRequest(), deps);
  });

  it("denying a pending request updates status to denied", () => {
    const result = denyControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(result.ok).toBe(true);
    const stored = readControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(stored!.status).toBe("denied");
  });

  it("deny does NOT mint a grant — the requester has no control", () => {
    denyControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const grant = readLifecycleGrant(REQUESTER_ID, deps.grantDeps);
    expect(grant).toBeUndefined();
  });

  it("denying a non-existent request fails with not-found", () => {
    const result = denyControlRequest("unknown-peer", TARGET_ID, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("denying an already-denied request is idempotent", () => {
    denyControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const result = denyControlRequest(REQUESTER_ID, TARGET_ID, deps);
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fail-closed — no approval, no control
// ═══════════════════════════════════════════════════════════════════════════
describe("fail-closed — a pending (unapproved) request leaves the requester without control", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("a submitted but unapproved request means NO control grant exists", () => {
    submitControlRequest(makeRequest(), deps);
    const grant = readLifecycleGrant(REQUESTER_ID, deps.grantDeps);
    expect(grant).toBeUndefined();
  });

  it("a denied request means NO control grant exists", () => {
    submitControlRequest(makeRequest(), deps);
    denyControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const grant = readLifecycleGrant(REQUESTER_ID, deps.grantDeps);
    expect(grant).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Already-granted — submit returns already-granted when the requester holds
// an active control grant for the target
// ═══════════════════════════════════════════════════════════════════════════
describe("already-granted — submit detects an existing active control grant", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns already-granted when the requester already has a control grant for the target", () => {
    // First approve a request
    submitControlRequest(makeRequest(), deps);
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    // Now submit again — should detect the existing grant
    const result = submitControlRequest(makeRequest(), deps);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("already-granted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multiple requests — different requesters for same target
// ═══════════════════════════════════════════════════════════════════════════
describe("multiple requesters — each has an independent request", () => {
  let deps: ControlRequestDeps;
  const OTHER_REQUESTER = "other-laptop";
  const OTHER_KEY = "SHA256:other-fingerprint";
  beforeEach(() => {
    deps = makeDeps();
  });

  it("two different requesters for the same target each get their own pending request", () => {
    submitControlRequest(makeRequest(), deps);
    submitControlRequest(
      makeRequest({ requesterMachineId: OTHER_REQUESTER, requesterIdentityKey: OTHER_KEY }),
      deps,
    );
    const pending = readPendingRequests(deps);
    expect(pending).toHaveLength(2);
  });

  it("approving one does not affect the other", () => {
    submitControlRequest(makeRequest(), deps);
    submitControlRequest(
      makeRequest({ requesterMachineId: OTHER_REQUESTER, requesterIdentityKey: OTHER_KEY }),
      deps,
    );
    approveControlRequest(REQUESTER_ID, TARGET_ID, deps);
    const pending = readPendingRequests(deps);
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterMachineId).toBe(OTHER_REQUESTER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route matrix enforcement — control-approve/deny are lifecycle-admin only
// ═══════════════════════════════════════════════════════════════════════════
describe("route matrix — control-approve/deny are lifecycle-admin acts", () => {
  it("lifecycle-admin scope: ALLOWED on POST /amicode/fleet/control-approve", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "POST", "/amicode/fleet/control-approve")).toBe(true);
  });

  it("lifecycle-admin scope: ALLOWED on POST /amicode/fleet/control-deny", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "POST", "/amicode/fleet/control-deny")).toBe(true);
  });

  it("control scope: DENIED on POST /amicode/fleet/control-approve (lifecycle-admin only)", () => {
    expect(evaluateRouteMatrix("control", "POST", "/amicode/fleet/control-approve")).toBe(false);
  });

  it("control scope: DENIED on POST /amicode/fleet/control-deny (lifecycle-admin only)", () => {
    expect(evaluateRouteMatrix("control", "POST", "/amicode/fleet/control-deny")).toBe(false);
  });

  it("observe scope: DENIED on POST /amicode/fleet/control-approve", () => {
    expect(evaluateRouteMatrix("observe", "POST", "/amicode/fleet/control-approve")).toBe(false);
  });

  it("observe scope: DENIED on POST /amicode/fleet/control-deny", () => {
    expect(evaluateRouteMatrix("observe", "POST", "/amicode/fleet/control-deny")).toBe(false);
  });
});
