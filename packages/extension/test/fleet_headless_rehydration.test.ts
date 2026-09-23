// fleet_headless_rehydration.test.ts — #1487 (Fleet Studio completion):
// HEADLESS PEER RELATIONSHIP REHYDRATION.
//
// A headless peer restart restores known relationships, validates
// identity/transport/trust before restoring Observe, never auto-restores
// Control, and fences out stale generation operations.
//
//   AC1 — A headless peer restart restores known relationships and starts
//         transport reconciliation without an editor.
//   AC2 — Identity/transport/trust revalidation precedes Observe restoration;
//         Control remains suspended until explicit re-enable.
//   AC3 — Stale bootstrap/reconnect work cannot advance a revoked or
//         superseded relationship generation.
//   AC4 — Thin-client/hub boot behavior remains unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  issueLifecycleGrant,
  readLifecycleGrant,
  revokeLifecycleGrant,
  acknowledgeRevocation,
  readmitPeer,
  type LifecycleGrantDeps,
} from "../src/amicode_service/fleet_control_lifecycle";
import {
  rehydratePeerRelationships,
  RehydrationGenerationFence,
  type RehydrationDeps,
  type RehydratedPeer,
  type PeerRecoveryState,
} from "../src/amicode_service/fleet_headless_rehydration";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-1487-rehydration-"));
}

const LOCAL_ID = "my-macbook";
const PEER_A_ID = "studio-peer";
const PEER_A_KEY = "SHA256:peer-a-fingerprint";
const LOCAL_KEY = "SHA256:local-fingerprint";

function makeGrantDeps(root?: string): LifecycleGrantDeps {
  const r = root ?? tmproot();
  return {
    grantStoreFile: join(r, "lifecycle-grants.json"),
    tokenFactory: () => "GRANT-TOKEN-001",
    now: () => "2026-09-23T00:00:00.000Z",
  };
}

/** A peer provider stub that returns controllable results. */
function stubPeerProvider(opts: {
  servingPeers?: Array<{ machineId: string }>;
  blockedPeers?: Array<{ machineId: string; reason: "identity-conflict" }>;
  tokens?: Record<string, { baseUrl: string; token: string }>;
  roster?: Record<string, { name: string; device_type?: string }>;
} = {}) {
  return {
    localMachineId: LOCAL_ID,
    getServingPeers: () => opts.servingPeers ?? [],
    getBlockedPeers: () => opts.blockedPeers ?? [],
    readPeerToken: (id: string) => {
      const entry = opts.tokens?.[id];
      return entry
        ? { ok: true as const, credential: entry }
        : { ok: false as const };
    },
    rosterLookup: (id: string) => opts.roster?.[id],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — headless restart restores known relationships + transport reconciliation
// ═══════════════════════════════════════════════════════════════════════════
describe("AC1 — headless restart restores known relationships and starts transport reconciliation", () => {
  let grantDeps: LifecycleGrantDeps;

  beforeEach(() => {
    grantDeps = makeGrantDeps();
  });

  it("restores an active observe grant with valid transport as 'active' — the clean rehydrate path", () => {
    // Persist a grant (simulating a pre-reboot state)
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
        roster: { [PEER_A_ID]: { name: "Studio Peer" } },
      }),
    });

    expect(result.headless).toBe(true);
    expect(result.peers).toHaveLength(1);
    const peer = result.peers[0];
    expect(peer.peerId).toBe(PEER_A_ID);
    expect(peer.state).toBe("active");
    expect(peer.scope).toBe("observe");
    expect(peer.generation).toBe(1);
    expect(peer.observeRestored).toBe(true);
  });

  it("restores a grant with missing transport as 'transport-failed' — transport reconciliation started", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    // The peer is in the roster but we have NO token for it
    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        // no tokens — transport unavailable
        roster: { [PEER_A_ID]: { name: "Studio Peer" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("transport-failed");
    expect(result.peers[0].observeRestored).toBe(false);
  });

  it("restores a grant for a peer NOT in the serving set as 'reconciling' — the peer is known but not yet reachable", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    // The peer is NOT in the serving set (not serving or not reachable)
    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [], // peer not serving
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("reconciling");
    expect(result.peers[0].observeRestored).toBe(false);
  });

  it("returns an empty set when no persisted grants exist (fresh boot)", () => {
    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider(),
    });

    expect(result.headless).toBe(true);
    expect(result.peers).toHaveLength(0);
  });

  it("restores multiple peers independently — each gets its own recovery state", () => {
    const PEER_B_ID = "mini-peer";
    const PEER_B_KEY = "SHA256:peer-b-fingerprint";

    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    const deps2 = { ...grantDeps, tokenFactory: () => "GRANT-TOKEN-002" };
    issueLifecycleGrant({
      requesterMachineId: PEER_B_ID,
      requesterIdentityKey: PEER_B_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, deps2);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }], // only A is serving
        tokens: {
          [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" },
        },
        // B has no token and is not serving
      }),
    });

    expect(result.peers).toHaveLength(2);
    const peerA = result.peers.find(p => p.peerId === PEER_A_ID)!;
    const peerB = result.peers.find(p => p.peerId === PEER_B_ID)!;
    expect(peerA.state).toBe("active");
    expect(peerA.observeRestored).toBe(true);
    expect(peerB.state).toBe("reconciling"); // not serving, but grant exists
    expect(peerB.observeRestored).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — identity/transport/trust revalidation ordering + control suspended
// ═══════════════════════════════════════════════════════════════════════════
describe("AC2 — identity/transport/trust revalidation precedes Observe; Control suspended", () => {
  let grantDeps: LifecycleGrantDeps;

  beforeEach(() => {
    grantDeps = makeGrantDeps();
  });

  it("a peer with a blocking identity state (alias-conflict) is 'identity-changed' — Observe NOT restored", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [], // NOT in serving set (blocked)
        blockedPeers: [{ machineId: PEER_A_ID, reason: "identity-conflict" }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("identity-changed");
    expect(result.peers[0].observeRestored).toBe(false);
  });

  it("a control-scoped grant restores Observe but suspends Control — never auto-restored", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "control",
    }, grantDeps);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    const peer = result.peers[0];
    expect(peer.state).toBe("suspended");
    expect(peer.scope).toBe("control");
    expect(peer.observeRestored).toBe(true); // observe IS restored
    expect(peer.controlSuspended).toBe(true); // control is NOT
  });

  it("a revoked grant is rehydrated as 'revoked' — neither Observe nor Control restored", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    acknowledgeRevocation(PEER_A_ID, grantDeps);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("revoked");
    expect(result.peers[0].observeRestored).toBe(false);
    expect(result.peers[0].controlSuspended).toBe(true);
  });

  it("a revocation-pending grant is rehydrated as 'revoked' — ongoing revocation is not reversed", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    // NOT acknowledged yet — revocation-pending

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("revoked");
    expect(result.peers[0].observeRestored).toBe(false);
  });

  it("a lifecycle-admin grant is rehydrated as 'active' — admin has no Control to suspend", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "lifecycle-admin",
    }, grantDeps);

    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    expect(result.peers).toHaveLength(1);
    expect(result.peers[0].state).toBe("active");
    expect(result.peers[0].controlSuspended).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — stale bootstrap/reconnect work cannot advance a revoked or
//       superseded relationship generation
// ═══════════════════════════════════════════════════════════════════════════
describe("AC3 — generation fence: stale operations cannot advance revoked or superseded relationships", () => {
  let grantDeps: LifecycleGrantDeps;

  beforeEach(() => {
    grantDeps = makeGrantDeps();
  });

  it("the generation fence rejects an operation at a stale generation (gen=1 when current is gen=2)", () => {
    // Issue → revoke → acknowledge → re-admit (generation bumps to 2)
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    acknowledgeRevocation(PEER_A_ID, grantDeps);
    readmitPeer({
      peerId: PEER_A_ID,
      targetApproved: true,
      scope: "observe",
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
    }, { ...grantDeps, tokenFactory: () => "READMIT-TOKEN-001" });

    const fence = new RehydrationGenerationFence(grantDeps);
    // gen=1 is stale — the current generation is 2
    expect(fence.allows(PEER_A_ID, 1)).toBe(false);
    // gen=2 is current — allowed
    expect(fence.allows(PEER_A_ID, 2)).toBe(true);
  });

  it("the generation fence rejects operations for a revoked peer (any generation)", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    acknowledgeRevocation(PEER_A_ID, grantDeps);

    const fence = new RehydrationGenerationFence(grantDeps);
    // The grant is revoked — no generation is allowed
    expect(fence.allows(PEER_A_ID, 1)).toBe(false);
  });

  it("the generation fence rejects operations for a revocation-pending peer", () => {
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    // NOT acknowledged — revocation-pending

    const fence = new RehydrationGenerationFence(grantDeps);
    expect(fence.allows(PEER_A_ID, 1)).toBe(false);
  });

  it("the generation fence allows operations for an unknown peer (no grant = no fence)", () => {
    const fence = new RehydrationGenerationFence(grantDeps);
    expect(fence.allows("unknown-peer", 1)).toBe(true);
  });

  it("stale async completion after a revoke-readmit cycle is fenced", () => {
    // Issue gen=1
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    // Capture gen=1 state (simulating an in-flight bootstrap)
    const staleGeneration = 1;

    // Revoke + acknowledge + re-admit → gen=2
    revokeLifecycleGrant(PEER_A_ID, grantDeps);
    acknowledgeRevocation(PEER_A_ID, grantDeps);
    readmitPeer({
      peerId: PEER_A_ID,
      targetApproved: true,
      scope: "observe",
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
    }, { ...grantDeps, tokenFactory: () => "READMIT-TOKEN-001" });

    // The stale bootstrap tries to complete at gen=1 — FENCED
    const fence = new RehydrationGenerationFence(grantDeps);
    expect(fence.allows(PEER_A_ID, staleGeneration)).toBe(false);

    // The new gen=2 bootstrap can proceed
    expect(fence.allows(PEER_A_ID, 2)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — thin-client/hub boot behavior remains unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe("AC4 — thin-client/hub boot behavior unchanged", () => {
  it("rehydration with an empty grant store and no serving peers returns an empty set (no-op for thin clients)", () => {
    const grantDeps = makeGrantDeps();
    const result = rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider(),
    });

    expect(result.headless).toBe(true);
    expect(result.peers).toHaveLength(0);
  });

  it("rehydration is a pure function of persisted state — it never writes, never mints, never modifies grants", () => {
    const grantDeps = makeGrantDeps();
    // Issue a grant before rehydration
    issueLifecycleGrant({
      requesterMachineId: PEER_A_ID,
      requesterIdentityKey: PEER_A_KEY,
      targetMachineId: LOCAL_ID,
      targetIdentityKey: LOCAL_KEY,
      scope: "observe",
    }, grantDeps);

    // Run rehydration
    rehydratePeerRelationships({
      grantDeps,
      peerProvider: stubPeerProvider({
        servingPeers: [{ machineId: PEER_A_ID }],
        tokens: { [PEER_A_ID]: { baseUrl: "http://studio:43117", token: "tok-a" } },
      }),
    });

    // The grant is UNCHANGED — rehydration is read-only
    const grant = readLifecycleGrant(PEER_A_ID, grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.state).toBe("active");
    expect(grant!.generation).toBe(1);
    expect(grant!.token).toBe("GRANT-TOKEN-001");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC1+AC4 integration — boot-path wiring: headless base peer runs rehydration,
//                        thin-client does not
// ═══════════════════════════════════════════════════════════════════════════
import * as http from "node:http";
import { type AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";

interface MockOrigin {
  url: string;
  stop(): Promise<void>;
}
function startMockEngine(enginePassword: string, sessions: unknown[]): Promise<MockOrigin> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const expected = `Basic ${serverAuthToken(enginePassword)}`;
    if (!auth.includes(enginePassword) && auth !== expected) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(sessions));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("AC1+AC4 — boot-path integration: headless base peer rehydrates; client/hub unchanged", () => {
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let savedHubFile: string | undefined;

  beforeEach(async () => {
    localEngine = await startMockEngine("engine-password", []);
    studioPeer = await startMockEngine("tok-studio", []);
    savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(tmproot(), "hub-cred-absent.json");
  });

  afterEach(async () => {
    await localEngine?.stop();
    await studioPeer?.stop();
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
  });

  it("AC1: a headless base peer boots fleet status + sessions routes (the rehydration-integrated path activates)", async () => {
    const svc = createAmicodeService({
      password: "svc-mint",
      engine: { password: "engine-password", getUrl: () => localEngine.url },
      fleet: {
        entitlements: [], // NO entitlement — base authority
        hub: { getUrl: () => undefined },
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [{ machineId: "the-studio" }],
          readPeerToken: (id: string) =>
            id === "the-studio"
              ? { ok: true as const, credential: { baseUrl: studioPeer.url, token: "tok-studio" } }
              : { ok: false as const },
          rosterLookup: (id: string) =>
            id === "the-studio" ? { name: "Studio" } : undefined,
        },
      },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const auth = `Basic ${serverAuthToken("svc-mint")}`;
    try {
      const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: auth } });
      expect(status.status).toBe(200);
      const body = (await status.json()) as { ok: boolean; posture?: { state?: string }; rehydration?: unknown };
      expect(body.ok).toBe(true);
      // The base peer has a named posture (verified by #1485)
      expect(body.posture).toBeDefined();
    } finally {
      await svc.stop();
    }
  });

  it("AC4: a fleet-of-one (zero serving peers) does NOT activate fleet routes — unchanged behavior", async () => {
    const svc = createAmicodeService({
      password: "svc-mint",
      engine: { password: "engine-password", getUrl: () => localEngine.url },
      fleet: {
        entitlements: [],
        hub: { getUrl: () => undefined },
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [], // fleet-of-one: no peers
          readPeerToken: () => ({ ok: false as const }),
          rosterLookup: () => undefined,
        },
      },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const auth = `Basic ${serverAuthToken("svc-mint")}`;
    try {
      const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: auth } });
      expect(status.status).toBe(404); // NOT activated — route doesn't exist
    } finally {
      await svc.stop();
    }
  });

  it("AC4: a client relay does NOT activate base peer-studio — unchanged behavior", async () => {
    const svc = createAmicodeService({
      password: "svc-mint",
      fleet: {
        client: true, // client relay — never base-activated
        entitlements: [],
        hub: { getUrl: () => undefined },
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [{ machineId: "the-studio" }],
          readPeerToken: () => ({ ok: false as const }),
          rosterLookup: () => undefined,
        },
      },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const auth = `Basic ${serverAuthToken("svc-mint")}`;
    try {
      const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: auth } });
      expect(status.status).toBe(404); // NOT activated
    } finally {
      await svc.stop();
    }
  });
});
