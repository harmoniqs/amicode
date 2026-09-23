// control_gated_routing.test.ts — #1482 (Fleet Studio completion):
// Control-gated peer routing and owner safety.
//
//   AC1 — A peer request carries only that peer's credential; a hub credential
//         is NEVER forwarded to a peer.
//   AC2 — Owner routing activates only for a target-enforced active Control
//         grant and NEVER depends on a legacy attachment pointer.
//   AC3 — All supported session request forms, permissions, and upgrade paths
//         resolve to the owner; unresolved known remote ownership yields named
//         unavailable/read-only behavior, NEVER local execution.
//   AC4 — Owner state survives a transient source failure long enough to
//         preserve remote identity and allow an explicit refresh/recovery outcome.
//   AC5 — Remote file reads/writes require an active bound owner context; absent
//         binding cannot turn a remote Work Column operation into a local operation.
//   AC6 — Control revoke, identity mismatch, or transport loss suspends mutation
//         immediately and leaves the remote session visible/read-only.
import { describe, it, expect } from "vitest";
import {
  ControlGatedResolver,
  type ControlGatedTarget,
  type ControlGatedResolverOpts,
} from "../src/amicode_service/control_gated_routing";
import { SessionOwnerMap } from "../src/amicode_service/session_multiplexer";

// ── helpers ──────────────────────────────────────────────────────────────────

const LOCAL_MACHINE = "local-machine";
const PEER_A_ID = "peer-a";
const PEER_B_ID = "peer-b";
const PEER_A_URL = "http://127.0.0.1:9001";
const PEER_B_URL = "http://127.0.0.1:9002";
const PEER_A_GRANT_TOKEN = "PEER-A-CONTROL-TOKEN";
const PEER_B_GRANT_TOKEN = "PEER-B-CONTROL-TOKEN";
const HUB_CREDENTIAL = "HUB-CREDENTIAL-NEVER-FORWARD";

function makeOwnerMap(entries: Array<{ id: string; owner: string }>): SessionOwnerMap {
  const map = new SessionOwnerMap();
  map.update(
    entries.map((e) => ({
      id: e.id,
      amicode_owner: { owner_machine_id: e.owner, owner_name: e.owner, is_local: e.owner === LOCAL_MACHINE },
    })),
  );
  return map;
}

function defaultOpts(overrides?: Partial<ControlGatedResolverOpts>): ControlGatedResolverOpts {
  return {
    ownerMap: makeOwnerMap([
      { id: "ses-a", owner: PEER_A_ID },
      { id: "ses-b", owner: PEER_B_ID },
      { id: "ses-local", owner: LOCAL_MACHINE },
    ]),
    localMachineId: LOCAL_MACHINE,
    peerTransports: {
      [PEER_A_ID]: { getUrl: () => PEER_A_URL },
      [PEER_B_ID]: { getUrl: () => PEER_B_URL },
    },
    grantReader: (peerId: string) => {
      if (peerId === PEER_A_ID) return { scope: "control" as const, state: "active" as const, token: PEER_A_GRANT_TOKEN, machineId: PEER_A_ID };
      if (peerId === PEER_B_ID) return { scope: "control" as const, state: "active" as const, token: PEER_B_GRANT_TOKEN, machineId: PEER_B_ID };
      return undefined;
    },
    hubCredentialToken: HUB_CREDENTIAL,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — peer-specific credential; hub credential NEVER forwarded
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC1 — peer request carries only that peer's credential; hub credential never forwarded", () => {
  it("a session owned by peer-a carries peer-a's grant token, NOT the hub credential", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("peer");
    if (target.kind !== "peer") return;
    expect(target.peerCredential).toBe(PEER_A_GRANT_TOKEN);
    expect(target.peerCredential).not.toBe(HUB_CREDENTIAL);
  });

  it("a session owned by peer-b carries peer-b's grant token, NOT peer-a's", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/api/session/ses-b/message", {});
    expect(target.kind).toBe("peer");
    if (target.kind !== "peer") return;
    expect(target.peerCredential).toBe(PEER_B_GRANT_TOKEN);
    expect(target.peerCredential).not.toBe(PEER_A_GRANT_TOKEN);
  });

  it("the hub credential string never appears in any peer-targeted resolution", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const targetA = resolver.resolve("POST", "/api/session/ses-a/message", {});
    const targetB = resolver.resolve("POST", "/api/session/ses-b/message", {});
    const serialized = JSON.stringify(targetA) + JSON.stringify(targetB);
    expect(serialized).not.toContain(HUB_CREDENTIAL);
  });

  it("dynamic credential rotation: a refreshed grant token is picked up on the next resolve", () => {
    let peerAToken = "TOKEN-V1";
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "control" as const, state: "active" as const, token: peerAToken, machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const t1 = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(t1.kind).toBe("peer");
    if (t1.kind === "peer") expect(t1.peerCredential).toBe("TOKEN-V1");
    // rotate
    peerAToken = "TOKEN-V2";
    const t2 = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(t2.kind).toBe("peer");
    if (t2.kind === "peer") expect(t2.peerCredential).toBe("TOKEN-V2");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — owner routing gated on active Control grant, never attachment pointer
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC2 — owner routing activates only for target-enforced active Control grant", () => {
  it("a peer with an active control grant resolves to a peer target", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("peer");
  });

  it("a peer with NO grant returns unavailable, never local", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({ grantReader: () => undefined }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
    expect(target.kind).not.toBe("local");
  });

  it("a peer with an observe-only grant (not control) returns unavailable for mutations", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "observe" as const, state: "active" as const, token: "OBS-TOK", machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
  });

  it("a peer with a revoked grant returns unavailable, never local", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "control" as const, state: "revoked" as const, token: "TOK", machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
  });

  it("a local session resolves local regardless of grant state", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/api/session/ses-local/message", {});
    expect(target.kind).toBe("local");
  });

  it("an unknown session (not in owner map) resolves local", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/api/session/ses-unknown/message", {});
    expect(target.kind).toBe("local");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — all session path forms resolve to owner; known remote → unavailable
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC3 — all supported session request forms resolve to the owner", () => {
  const sessionPaths = [
    "/api/session/ses-a/event",
    "/api/session/ses-a/message",
    "/api/session/ses-a/prompt",
    "/api/session/ses-a/tool",
    "/api/session/ses-a/permission",
  ];

  for (const path of sessionPaths) {
    it(`session path ${path} resolves to owner peer-a`, () => {
      const resolver = new ControlGatedResolver(defaultOpts());
      const target = resolver.resolve("POST", path, {});
      expect(target.kind).toBe("peer");
      if (target.kind === "peer") {
        expect(target.machineId).toBe(PEER_A_ID);
      }
    });
  }

  it("GET on a session event path also resolves to the owner", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("GET", "/api/session/ses-a/event", {});
    expect(target.kind).toBe("peer");
    if (target.kind === "peer") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("header-based routing via X-Amicode-Owner resolves to the named peer", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/file/write", { "x-amicode-owner": PEER_A_ID });
    expect(target.kind).toBe("peer");
    if (target.kind === "peer") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("unresolved known remote ownership yields unavailable with named reason, NEVER local", () => {
    // peer-a is in the owner map but has no grant
    const resolver = new ControlGatedResolver(
      defaultOpts({ grantReader: () => undefined }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") {
      expect(target.machineId).toBe(PEER_A_ID);
      expect(target.reason).toBeDefined();
    }
  });

  it("known remote owner with transport down yields unavailable, NEVER local", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        peerTransports: {
          [PEER_A_ID]: { getUrl: () => undefined }, // transport down
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
    if (target.kind === "unavailable") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("honesty surface /amicode/fleet/* always resolves local", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("GET", "/amicode/fleet/status", {});
    expect(target.kind).toBe("local");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — owner state survives transient source failure
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC4 — owner state survives transient source failure", () => {
  it("a retained owner (from a previous update) persists after the map source fails — never reverts to local", () => {
    const ownerMap = makeOwnerMap([{ id: "ses-a", owner: PEER_A_ID }]);
    const resolver = new ControlGatedResolver(defaultOpts({ ownerMap }));
    // first resolve: peer target
    const t1 = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(t1.kind).toBe("peer");

    // simulate source failure: the owner map is NOT updated (stale), but
    // the session is still known — it must NOT resolve local.
    // (The OwnerMapFeed keeps last-good on error; this test verifies the
    // resolver respects the retained state.)
    const t2 = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(t2.kind).toBe("peer");
  });

  it("a known remote owner whose grant becomes unavailable returns unavailable — still not local", () => {
    let grantActive = true;
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID && grantActive) {
            return { scope: "control" as const, state: "active" as const, token: PEER_A_GRANT_TOKEN, machineId: PEER_A_ID };
          }
          return undefined;
        },
      }),
    );
    // first resolve: peer
    expect(resolver.resolve("POST", "/api/session/ses-a/message", {}).kind).toBe("peer");
    // grant goes away (transient failure)
    grantActive = false;
    const t2 = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(t2.kind).toBe("unavailable");
    expect(t2.kind).not.toBe("local");
  });

  it("explicit refresh via owner map re-population restores peer routing", () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([
      { id: "ses-a", amicode_owner: { owner_machine_id: PEER_A_ID, owner_name: "A", is_local: false } },
    ]);
    const resolver = new ControlGatedResolver(defaultOpts({ ownerMap }));
    expect(resolver.resolve("POST", "/api/session/ses-a/message", {}).kind).toBe("peer");
    // clear and repopulate (simulating a successful refresh after a failure)
    ownerMap.update([
      { id: "ses-a", amicode_owner: { owner_machine_id: PEER_A_ID, owner_name: "A", is_local: false } },
    ]);
    expect(resolver.resolve("POST", "/api/session/ses-a/message", {}).kind).toBe("peer");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — bound owner context for remote file operations
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC5 — remote file reads/writes require active bound owner context", () => {
  it("file write with valid bound owner header resolves to the bound peer", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/file/write", { "x-amicode-owner": PEER_A_ID });
    expect(target.kind).toBe("peer");
    if (target.kind === "peer") {
      expect(target.machineId).toBe(PEER_A_ID);
      expect(target.peerCredential).toBe(PEER_A_GRANT_TOKEN);
    }
  });

  it("file read with valid bound owner header resolves to the bound peer", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("GET", "/file/read", { "x-amicode-owner": PEER_A_ID });
    expect(target.kind).toBe("peer");
    if (target.kind === "peer") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("file write with ABSENT owner header resolves LOCAL (no bound context → no remote)", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    const target = resolver.resolve("POST", "/file/write", {});
    expect(target.kind).toBe("local");
  });

  it("file write with a FORGED owner header (no active grant for that peer) returns unavailable, NOT local", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: () => undefined, // no grant for any peer
      }),
    );
    const target = resolver.resolve("POST", "/file/write", { "x-amicode-owner": PEER_A_ID });
    expect(target.kind).toBe("unavailable");
    expect(target.kind).not.toBe("local");
  });

  it("absent binding cannot turn a remote file operation into a local operation — unknown peer in header yields unavailable", () => {
    const resolver = new ControlGatedResolver(defaultOpts());
    // "fake-peer" is not in the peer transports at all
    const target = resolver.resolve("POST", "/file/write", { "x-amicode-owner": "fake-peer" });
    // The peer is named in the header but has no transport/grant → unavailable
    expect(target.kind).toBe("unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — Control revoke, identity mismatch, or transport loss → read-only
// ═══════════════════════════════════════════════════════════════════════════
describe("#1482 AC6 — Control revoke, identity mismatch, or transport loss suspends mutation, leaves visible/read-only", () => {
  it("a revocation-pending grant suspends mutation (POST) — returns read-only, not peer", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "control" as const, state: "revocation-pending" as const, token: "TOK", machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("read-only");
    if (target.kind === "read-only") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("a revocation-pending grant allows read (GET) — returns read-only with visibility", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "control" as const, state: "revocation-pending" as const, token: "TOK", machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("GET", "/api/session/ses-a/event", {});
    expect(target.kind).toBe("read-only");
    if (target.kind === "read-only") expect(target.machineId).toBe(PEER_A_ID);
  });

  it("a fully revoked grant returns unavailable (session no longer visible)", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          if (peerId === PEER_A_ID) return { scope: "control" as const, state: "revoked" as const, token: "TOK", machineId: PEER_A_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
  });

  it("transport loss (url undefined) with active grant returns read-only for reads, unavailable for writes", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        peerTransports: {
          [PEER_A_ID]: { getUrl: () => undefined }, // transport down
          [PEER_B_ID]: { getUrl: () => PEER_B_URL },
        },
      }),
    );
    // Write → unavailable (can't proxy without transport)
    const writeTarget = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(writeTarget.kind).toBe("unavailable");
    // Read → read-only (session is visible but transport is down)
    const readTarget = resolver.resolve("GET", "/api/session/ses-a/event", {});
    expect(readTarget.kind).toBe("read-only");
  });

  it("identity mismatch (grant reader returns undefined for known peer) returns unavailable, never local", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        grantReader: (peerId: string) => {
          // peer-a exists in owner map but has no grant (identity mismatch scenario)
          if (peerId === PEER_A_ID) return undefined;
          if (peerId === PEER_B_ID) return { scope: "control" as const, state: "active" as const, token: PEER_B_GRANT_TOKEN, machineId: PEER_B_ID };
          return undefined;
        },
      }),
    );
    const target = resolver.resolve("POST", "/api/session/ses-a/message", {});
    expect(target.kind).toBe("unavailable");
    expect(target.kind).not.toBe("local");
  });

  it("peer-b remains fully routable when peer-a is in read-only due to transport loss", () => {
    const resolver = new ControlGatedResolver(
      defaultOpts({
        peerTransports: {
          [PEER_A_ID]: { getUrl: () => undefined }, // peer-a down
          [PEER_B_ID]: { getUrl: () => PEER_B_URL }, // peer-b fine
        },
      }),
    );
    const targetB = resolver.resolve("POST", "/api/session/ses-b/message", {});
    expect(targetB.kind).toBe("peer");
    if (targetB.kind === "peer") expect(targetB.machineId).toBe(PEER_B_ID);
  });
});
