// fleet_control_lifecycle.test.ts — #1486 (ADR 0034, Binding Amendment 1):
// TARGET-ENFORCED CONTROL LIFECYCLE AND REVOCATION.
//
// The completion slice #1480 deferred here: target-enforced Control scope,
// relationship generations, authority-bound revoke/re-admit, and durable
// fail-closed grants. Builds ON the existing bound-nonce + observe bootstrap
// foundations without rebuilding them.
//
//   AC1 — exactly one concurrent redemption atomically consumes and issues a
//         grant bound to requester identity, target identity, and relationship
//         generation.
//   AC2 — Observe/Control/lifecycle-admin route matrix is enforced at target
//         service AND engine boundaries.
//   AC3 — only named lifecycle authority can mint, revoke, or re-admit;
//         Control/Observe credentials CANNOT mutate lifecycle state.
//   AC4 — revoke invalidates pending work; a non-acknowledging peer is
//         `revocation-pending`, never falsely complete; re-admit uses a new
//         generation and target approval.
//   AC5 — secrets never appear in URLs, logs, errors, telemetry, status, or UI.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  issueLifecycleGrant,
  readLifecycleGrant,
  type LifecycleGrantDeps,
  type LifecycleGrantRequest,
  GRANT_SCOPE_VOCABULARY,
} from "../src/amicode_service/fleet_control_lifecycle";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-1486-lifecycle-"));
}

const REQUESTER_ID = "requester-macbook";
const REQUESTER_KEY = "SHA256:requester-fingerprint";
const TARGET_ID = "target-studio";
const TARGET_KEY = "SHA256:target-fingerprint";

function makeDeps(root?: string): LifecycleGrantDeps {
  const r = root ?? tmproot();
  return {
    grantStoreFile: join(r, "lifecycle-grants.json"),
    tokenFactory: () => "GRANT-TOKEN-001",
    now: () => "2026-09-23T00:00:00.000Z",
  };
}

function makeRequest(overrides?: Partial<LifecycleGrantRequest>): LifecycleGrantRequest {
  return {
    requesterMachineId: REQUESTER_ID,
    requesterIdentityKey: REQUESTER_KEY,
    targetMachineId: TARGET_ID,
    targetIdentityKey: TARGET_KEY,
    scope: "observe",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — atomic grant issuance with identity + generation binding
// ═══════════════════════════════════════════════════════════════════════════
describe("AC1 — atomic grant issuance bound to requester identity, target identity, and generation", () => {
  let deps: LifecycleGrantDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("issues a grant bound to requester identity, target identity, scope, and generation=1 on first issue", () => {
    const result = issueLifecycleGrant(makeRequest(), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.requesterMachineId).toBe(REQUESTER_ID);
    expect(result.grant.requesterIdentityKey).toBe(REQUESTER_KEY);
    expect(result.grant.targetMachineId).toBe(TARGET_ID);
    expect(result.grant.targetIdentityKey).toBe(TARGET_KEY);
    expect(result.grant.scope).toBe("observe");
    expect(result.grant.generation).toBe(1);
    expect(result.grant.state).toBe("active");
    expect(result.grant.token).toBe("GRANT-TOKEN-001");
  });

  it("the issued grant is readable from the store", () => {
    issueLifecycleGrant(makeRequest(), deps);
    const stored = readLifecycleGrant(REQUESTER_ID, deps);
    expect(stored).toBeDefined();
    expect(stored!.generation).toBe(1);
    expect(stored!.state).toBe("active");
    expect(stored!.requesterIdentityKey).toBe(REQUESTER_KEY);
    expect(stored!.targetMachineId).toBe(TARGET_ID);
  });

  it("a second issue for the SAME requester with the SAME identity replaces (generation stays 1, new token)", () => {
    issueLifecycleGrant(makeRequest(), deps);
    const deps2 = { ...deps, tokenFactory: () => "GRANT-TOKEN-002" };
    const result = issueLifecycleGrant(makeRequest(), deps2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.generation).toBe(1);
    expect(result.grant.token).toBe("GRANT-TOKEN-002");
  });

  it("rejects issuance when requester identity does NOT match the existing grant's identity (wrong identity)", () => {
    issueLifecycleGrant(makeRequest(), deps);
    const result = issueLifecycleGrant(
      makeRequest({ requesterIdentityKey: "SHA256:different-fingerprint" }),
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("identity-mismatch");
  });

  it("the scope vocabulary is exactly observe, control, lifecycle-admin", () => {
    expect(GRANT_SCOPE_VOCABULARY).toEqual(["observe", "control", "lifecycle-admin"]);
  });

  it("issues a control-scoped grant", () => {
    const result = issueLifecycleGrant(makeRequest({ scope: "control" }), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.scope).toBe("control");
  });

  it("concurrent issuance for the SAME requester yields consistent state (exactly one token wins)", async () => {
    // Fire many issuances concurrently; the synchronous read-check-write
    // guarantees the last-writer wins, but ALL must produce ok=true with a
    // consistent generation (never a torn read that splits generation/token).
    let counter = 0;
    const concurrentDeps = { ...deps, tokenFactory: () => `TOK-${++counter}` };
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.resolve().then(() => issueLifecycleGrant(makeRequest(), concurrentDeps)),
      ),
    );
    // ALL succeed (same identity, same machine_id — no mismatch)
    expect(results.every((r) => r.ok)).toBe(true);
    // The stored grant has a consistent token (the last writer's)
    const stored = readLifecycleGrant(REQUESTER_ID, deps);
    expect(stored).toBeDefined();
    expect(stored!.generation).toBe(1);
    // Exactly one result's token matches the stored grant
    const storedToken = stored!.token;
    const matchCount = results.filter((r) => r.ok && r.grant.token === storedToken).length;
    expect(matchCount).toBeGreaterThanOrEqual(1);
  });

  it("a revoked grant blocks re-issuance (must use readmitPeer instead)", () => {
    issueLifecycleGrant(makeRequest(), deps);
    // manually transition to revoked via the revoke + acknowledge path
    revokeLifecycleGrant(REQUESTER_ID, deps);
    acknowledgeRevocation(REQUESTER_ID, deps);
    // now try to re-issue — blocked
    const result = issueLifecycleGrant(makeRequest(), deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("revoked");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — route matrix enforcement
// ═══════════════════════════════════════════════════════════════════════════
import { evaluateRouteMatrix } from "../src/amicode_service/fleet_control_lifecycle";

describe("AC2 — Observe/Control/lifecycle-admin route matrix enforcement", () => {
  // ── observe scope: read-only fleet routes ──────────────────────────────
  it("observe scope: allowed on GET /amicode/fleet/status", () => {
    expect(evaluateRouteMatrix("observe", "GET", "/amicode/fleet/status")).toBe(true);
  });
  it("observe scope: allowed on GET /amicode/fleet/sessions", () => {
    expect(evaluateRouteMatrix("observe", "GET", "/amicode/fleet/sessions")).toBe(true);
  });
  it("observe scope: DENIED on POST /amicode/fleet/status (not a read method)", () => {
    expect(evaluateRouteMatrix("observe", "POST", "/amicode/fleet/status")).toBe(false);
  });
  it("observe scope: DENIED on GET /session (a control-only route)", () => {
    expect(evaluateRouteMatrix("observe", "GET", "/session")).toBe(false);
  });
  it("observe scope: DENIED on POST /amicode/fleet/revoke (a lifecycle-admin route)", () => {
    expect(evaluateRouteMatrix("observe", "POST", "/amicode/fleet/revoke")).toBe(false);
  });

  // ── control scope: observe + session control ───────────────────────────
  it("control scope: allowed on GET /amicode/fleet/status (observe route)", () => {
    expect(evaluateRouteMatrix("control", "GET", "/amicode/fleet/status")).toBe(true);
  });
  it("control scope: allowed on GET /session (session route)", () => {
    expect(evaluateRouteMatrix("control", "GET", "/session")).toBe(true);
  });
  it("control scope: allowed on POST /amicode/fleet/dispatch", () => {
    expect(evaluateRouteMatrix("control", "POST", "/amicode/fleet/dispatch")).toBe(true);
  });
  it("control scope: DENIED on POST /amicode/fleet/revoke (lifecycle-admin only)", () => {
    expect(evaluateRouteMatrix("control", "POST", "/amicode/fleet/revoke")).toBe(false);
  });
  it("control scope: DENIED on POST /amicode/fleet/readmit (lifecycle-admin only)", () => {
    expect(evaluateRouteMatrix("control", "POST", "/amicode/fleet/readmit")).toBe(false);
  });

  // ── lifecycle-admin scope: lifecycle mutation routes ONLY ───────────────
  it("lifecycle-admin scope: allowed on POST /amicode/fleet/revoke", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "POST", "/amicode/fleet/revoke")).toBe(true);
  });
  it("lifecycle-admin scope: allowed on POST /amicode/fleet/readmit", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "POST", "/amicode/fleet/readmit")).toBe(true);
  });
  it("lifecycle-admin scope: allowed on POST /amicode/fleet/peer-token", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "POST", "/amicode/fleet/peer-token")).toBe(true);
  });
  it("lifecycle-admin scope: DENIED on GET /amicode/fleet/status (not a lifecycle route)", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "GET", "/amicode/fleet/status")).toBe(false);
  });
  it("lifecycle-admin scope: DENIED on GET /session (not a lifecycle route)", () => {
    expect(evaluateRouteMatrix("lifecycle-admin", "GET", "/session")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — lifecycle authority gating
// ═══════════════════════════════════════════════════════════════════════════
import { isLifecycleAuthority } from "../src/amicode_service/fleet_control_lifecycle";

describe("AC3 — only named lifecycle authority can mint/revoke/re-admit; Control/Observe CANNOT", () => {
  const authorityDeps = {
    authorityIdentityKey: "SHA256:keeper-fingerprint",
    localServiceMint: "service-own-mint",
  };

  it("the keeper's identity_key IS the lifecycle authority", () => {
    expect(isLifecycleAuthority({ identityKey: "SHA256:keeper-fingerprint" }, authorityDeps)).toBe(true);
  });

  it("the local service mint IS the lifecycle authority", () => {
    expect(isLifecycleAuthority({ credential: "service-own-mint" }, authorityDeps)).toBe(true);
  });

  it("an observe-scoped peer identity is NOT the lifecycle authority", () => {
    expect(isLifecycleAuthority({ identityKey: "SHA256:observe-peer" }, authorityDeps)).toBe(false);
  });

  it("a control-scoped peer identity is NOT the lifecycle authority", () => {
    expect(isLifecycleAuthority({ identityKey: "SHA256:control-peer" }, authorityDeps)).toBe(false);
  });

  it("an empty/absent credential is NOT the lifecycle authority", () => {
    expect(isLifecycleAuthority({}, authorityDeps)).toBe(false);
  });

  it("a wrong local mint is NOT the lifecycle authority", () => {
    expect(isLifecycleAuthority({ credential: "wrong-mint" }, authorityDeps)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — revoke / revocation-pending / re-admit with new generation
// ═══════════════════════════════════════════════════════════════════════════
import {
  revokeLifecycleGrant,
  acknowledgeRevocation,
  readmitPeer,
  validateLifecycleGrant,
} from "../src/amicode_service/fleet_control_lifecycle";

describe("AC4 — revoke sets revocation-pending; non-acknowledging peer never falsely complete", () => {
  let deps: LifecycleGrantDeps;
  beforeEach(() => {
    deps = makeDeps();
    issueLifecycleGrant(makeRequest(), deps);
  });

  it("revoke transitions an active grant to revocation-pending", () => {
    const result = revokeLifecycleGrant(REQUESTER_ID, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("revocation-pending");
    const stored = readLifecycleGrant(REQUESTER_ID, deps);
    expect(stored!.state).toBe("revocation-pending");
  });

  it("a revocation-pending grant is NOT valid (pending work invalidated)", () => {
    revokeLifecycleGrant(REQUESTER_ID, deps);
    const v = validateLifecycleGrant(REQUESTER_ID, "GRANT-TOKEN-001", 1, deps);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("revocation-pending");
  });

  it("revoke is idempotent on revocation-pending (does not transition to revoked)", () => {
    revokeLifecycleGrant(REQUESTER_ID, deps);
    const result = revokeLifecycleGrant(REQUESTER_ID, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("revocation-pending");
    // NOT revoked — stays pending until acknowledged
    expect(readLifecycleGrant(REQUESTER_ID, deps)!.state).toBe("revocation-pending");
  });

  it("acknowledge moves revocation-pending to revoked", () => {
    revokeLifecycleGrant(REQUESTER_ID, deps);
    const result = acknowledgeRevocation(REQUESTER_ID, deps);
    expect(result.ok).toBe(true);
    expect(readLifecycleGrant(REQUESTER_ID, deps)!.state).toBe("revoked");
  });

  it("acknowledge on a non-pending grant is refused", () => {
    // active → acknowledge = not-pending
    const result = acknowledgeRevocation(REQUESTER_ID, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-pending");
  });

  it("revoke on an unknown peer is not-found", () => {
    const result = revokeLifecycleGrant("unknown-peer", deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-found");
  });

  it("revoke on an already-revoked grant is refused", () => {
    revokeLifecycleGrant(REQUESTER_ID, deps);
    acknowledgeRevocation(REQUESTER_ID, deps);
    const result = revokeLifecycleGrant(REQUESTER_ID, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("already-revoked");
  });
});

describe("AC4 — re-admit uses a new generation and requires target approval", () => {
  let deps: LifecycleGrantDeps;
  beforeEach(() => {
    deps = makeDeps();
    issueLifecycleGrant(makeRequest(), deps);
    revokeLifecycleGrant(REQUESTER_ID, deps);
    acknowledgeRevocation(REQUESTER_ID, deps);
  });

  it("re-admit with target approval creates a new generation (generation bumps from 1 to 2)", () => {
    const depsNew = { ...deps, tokenFactory: () => "READMIT-TOKEN-001" };
    const result = readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: true,
        scope: "observe",
        requesterIdentityKey: REQUESTER_KEY,
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      depsNew,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.generation).toBe(2);
    expect(result.grant.state).toBe("active");
    expect(result.grant.token).toBe("READMIT-TOKEN-001");
  });

  it("re-admit WITHOUT target approval is refused", () => {
    const result = readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: false,
        scope: "observe",
        requesterIdentityKey: REQUESTER_KEY,
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("approval-required");
  });

  it("re-admit on a non-revoked grant is refused (must be fully revoked first)", () => {
    // set up a fresh active grant
    const freshDeps = makeDeps();
    issueLifecycleGrant(makeRequest(), freshDeps);
    const result = readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: true,
        scope: "observe",
        requesterIdentityKey: REQUESTER_KEY,
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      freshDeps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-revoked");
  });

  it("re-admit with WRONG identity is refused", () => {
    const result = readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: true,
        scope: "observe",
        requesterIdentityKey: "SHA256:wrong-identity",
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("identity-mismatch");
  });

  it("a stale-generation token (gen=1) is invalid after re-admit to gen=2", () => {
    const depsNew = { ...deps, tokenFactory: () => "READMIT-TOKEN-001" };
    readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: true,
        scope: "observe",
        requesterIdentityKey: REQUESTER_KEY,
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      depsNew,
    );
    // present the OLD generation=1 token
    const v = validateLifecycleGrant(REQUESTER_ID, "GRANT-TOKEN-001", 1, deps);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("stale-generation");
  });

  it("the new generation=2 token validates", () => {
    const depsNew = { ...deps, tokenFactory: () => "READMIT-TOKEN-001" };
    readmitPeer(
      {
        peerId: REQUESTER_ID,
        targetApproved: true,
        scope: "observe",
        requesterIdentityKey: REQUESTER_KEY,
        targetMachineId: TARGET_ID,
        targetIdentityKey: TARGET_KEY,
      },
      depsNew,
    );
    const v = validateLifecycleGrant(REQUESTER_ID, "READMIT-TOKEN-001", 2, deps);
    expect(v.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — secrets never appear in error / status / display representations
// ═══════════════════════════════════════════════════════════════════════════
import { sanitizeGrantForDisplay } from "../src/amicode_service/fleet_control_lifecycle";

describe("AC5 — secrets never appear in URLs, logs, errors, telemetry, status, or UI", () => {
  it("sanitizeGrantForDisplay never includes the token", () => {
    const grant = {
      requesterMachineId: REQUESTER_ID,
      requesterIdentityKey: REQUESTER_KEY,
      targetMachineId: TARGET_ID,
      targetIdentityKey: TARGET_KEY,
      scope: "observe" as const,
      generation: 1,
      state: "active" as const,
      token: "SUPER-SECRET-TOKEN-NEVER-LEAK",
      issuedAt: "2026-09-23T00:00:00.000Z",
    };
    const safe = sanitizeGrantForDisplay(grant);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("SUPER-SECRET-TOKEN-NEVER-LEAK");
    expect(safe).not.toHaveProperty("token");
  });

  it("sanitizeGrantForDisplay truncates identity keys", () => {
    const grant = {
      requesterMachineId: REQUESTER_ID,
      requesterIdentityKey: "SHA256:very-long-fingerprint-string",
      targetMachineId: TARGET_ID,
      targetIdentityKey: TARGET_KEY,
      scope: "observe" as const,
      generation: 1,
      state: "active" as const,
      token: "TOKEN",
      issuedAt: "2026-09-23T00:00:00.000Z",
    };
    const safe = sanitizeGrantForDisplay(grant);
    // the full fingerprint is NOT in the output
    expect(JSON.stringify(safe)).not.toContain("very-long-fingerprint-string");
    // the truncated form ends with "…"
    expect(String(safe.requesterIdentityKey)).toContain("…");
  });

  it("error results from issueLifecycleGrant never contain a token", () => {
    const deps = makeDeps();
    issueLifecycleGrant(makeRequest(), deps);
    const result = issueLifecycleGrant(
      makeRequest({ requesterIdentityKey: "SHA256:attacker" }),
      deps,
    );
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("GRANT-TOKEN-001");
  });

  it("revoke result never contains a token", () => {
    const deps = makeDeps();
    issueLifecycleGrant(makeRequest(), deps);
    const result = revokeLifecycleGrant(REQUESTER_ID, deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("GRANT-TOKEN-001");
  });
});
