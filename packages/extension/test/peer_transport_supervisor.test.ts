// peer_transport_supervisor.test.ts — #1479 (ADR 0034, Fleet Studio
// completion): the managed per-peer transport SUPERVISOR, driven through its
// public interface with an injected transport factory (a mock handle — the
// real ssh-forward bring-up is exercised by the existing
// amicode_service_attachment_transport suite and REUSED, not duplicated, per
// the issue's Testing Decisions). One describe per acceptance criterion.
import { describe, it, expect } from "vitest";
import {
  PeerTransportSupervisor,
  reconnectBackoffMs,
  type PeerIdentity,
  type PeerTransportFactory,
  type AttachmentTransportHandle,
} from "../src/amicode_service/peer_transport_supervisor";
import { sshForwardArgs } from "../src/amicode_service/fleet_transport";
import { attachmentForwardArgs } from "../src/amicode_service/attachment_transport";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A mock transport handle that records stop() but spawns no process. */
function mockHandle(localUrl: string): AttachmentTransportHandle & { stopped: boolean } {
  return {
    kind: "ssh",
    localUrl,
    provider: {
      kind: "ssh",
      resolveBaseUrl: () => new URL(localUrl),
      health: async () => ({ reachable: true, latencyMs: 1, version: null }),
      start: async () => {},
      stop: async () => {},
    },
    stopped: false,
    async stop() {
      this.stopped = true;
    },
  };
}

/** A tracking factory: each call returns a handle whose localUrl echoes the
 *  ALLOCATED localPort, so tests can assert distinct, non-colliding endpoints. */
function trackingFactory(): PeerTransportFactory & {
  handles: Array<ReturnType<typeof mockHandle>>;
  calls: Array<{ machine_id: string; sshAlias: string; remotePort: number; localPort: number }>;
} {
  const handles: Array<ReturnType<typeof mockHandle>> = [];
  const calls: Array<{ machine_id: string; sshAlias: string; remotePort: number; localPort: number }> = [];
  const factory: PeerTransportFactory = async ({ target, remotePort, localPort }) => {
    calls.push({ machine_id: target.machine_id, sshAlias: target.sshAlias, remotePort, localPort });
    const h = mockHandle(`http://127.0.0.1:${localPort}`);
    handles.push(h);
    return h;
  };
  return Object.assign(factory, { handles, calls });
}

const peer = (over: Partial<PeerIdentity> = {}): PeerIdentity => ({
  identityKey: "sha256:K1",
  machineId: "m1",
  sshAlias: "peer-one@host",
  transport: "ssh",
  ...over,
});

/** An identity probe that always answers a peer's OWN expected key (verifies). */
const matchingProbe = async (p: PeerIdentity): Promise<string> => p.identityKey;

// ── AC1: distinct loopback endpoints for the same remote port ────────────────

describe("AC1 — two peers on the SAME remote port get distinct local loopback endpoints (no collision)", () => {
  it("allocates distinct local ports and loopback URLs for two peers both targeting remotePort 43117", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe, remotePort: 43117 });

    const a = await sup.connect(peer({ identityKey: "sha256:A", machineId: "mA", sshAlias: "a@h" }));
    const b = await sup.connect(peer({ identityKey: "sha256:B", machineId: "mB", sshAlias: "b@h" }));

    expect(a.localPort).toBeDefined();
    expect(b.localPort).toBeDefined();
    expect(a.localPort).not.toBe(b.localPort); // no local collision despite same remote port
    expect(a.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:/); // loopback bind
    expect(b.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(a.localUrl).not.toBe(b.localUrl);
    // both forwards dialed the SAME remote port — the collision was only ever local
    expect(factory.calls.every((c) => c.remotePort === 43117)).toBe(true);
  });

  it("skips a reserved port (the hub tunnel's port) — never lands a peer on the hub's local bind", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({
      factory,
      identityProbe: matchingProbe,
      localPortBase: 43117,
      reservedPorts: [43117],
    });
    const a = await sup.connect(peer({ identityKey: "sha256:A" }));
    expect(a.localPort).not.toBe(43117);
  });

  it("concurrent connects to three distinct peers never collide on a local port", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });
    const [a, b, c] = await Promise.all([
      sup.connect(peer({ identityKey: "sha256:A" })),
      sup.connect(peer({ identityKey: "sha256:B" })),
      sup.connect(peer({ identityKey: "sha256:C" })),
    ]);
    const ports = new Set([a.localPort, b.localPort, c.localPort]);
    expect(ports.size).toBe(3);
  });
});

// ── AC2: keyed by stable identity, not by ephemeral URL/hostname/name ────────

describe("AC2 — a peer transport is keyed by stable identity, not by URL/hostname/display name", () => {
  it("re-connecting the SAME identity_key with a changed alias/hostname updates the SAME transport (not a second one)", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });

    await sup.connect(peer({ identityKey: "sha256:K", sshAlias: "old-alias@host-1" }));
    await sup.connect(peer({ identityKey: "sha256:K", sshAlias: "new-alias@host-2" }));

    expect(sup.list()).toHaveLength(1); // keyed by identity — the alias change did NOT fork a transport
    expect(sup.get("sha256:K")?.sshAlias).toBe("new-alias@host-2");
  });

  it("two peers sharing an alias but with DIFFERENT identity_keys are two DISTINCT transports", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });

    await sup.connect(peer({ identityKey: "sha256:K1", sshAlias: "same-alias@host" }));
    await sup.connect(peer({ identityKey: "sha256:K2", sshAlias: "same-alias@host" }));

    expect(sup.list()).toHaveLength(2); // keyed by identity, not by the shared alias
    expect(sup.get("sha256:K1")).toBeDefined();
    expect(sup.get("sha256:K2")).toBeDefined();
  });
});

// ── AC3: per-peer failure isolation + reconnect backoff ──────────────────────

describe("AC3 — one failed/reconnecting peer changes only that peer's state, never another peer or local serving", () => {
  it("a child exit on peer A leaves peer B's transport untouched (state and live handle)", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });
    await sup.connect(peer({ identityKey: "sha256:A" }));
    await sup.connect(peer({ identityKey: "sha256:B" }));
    const bBefore = sup.get("sha256:B");
    const bHandle = factory.handles[1];

    const aAfter = sup.noteChildExit("sha256:A", "ssh child exited");

    expect(aAfter?.status).toBe("reconnecting");
    expect(aAfter?.credentialForwardingAllowed).toBe(false);
    // B is entirely unchanged — the isolation invariant
    expect(sup.get("sha256:B")).toEqual(bBefore);
    expect(sup.canForwardCredential("sha256:B")).toBe(true);
    expect(bHandle.stopped).toBe(false); // B's forward was never touched
  });

  it("reconnect backoff grows per attempt, then the peer is FAILED after the max — isolated to that peer", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe, maxReconnectAttempts: 3 });
    await sup.connect(peer({ identityKey: "sha256:A" }));

    const s1 = sup.noteChildExit("sha256:A");
    expect(s1?.status).toBe("reconnecting");
    expect(s1?.attempts).toBe(1);
    expect(s1?.nextRetryMs).toBe(reconnectBackoffMs(1));

    const s2 = sup.noteChildExit("sha256:A");
    expect(s2?.attempts).toBe(2);
    expect(s2?.nextRetryMs).toBe(reconnectBackoffMs(2));
    expect(reconnectBackoffMs(2)).toBeGreaterThan(reconnectBackoffMs(1));

    const s3 = sup.noteChildExit("sha256:A");
    expect(s3?.status).toBe("reconnecting");
    expect(s3?.attempts).toBe(3);

    const s4 = sup.noteChildExit("sha256:A"); // exceeds max → failed
    expect(s4?.status).toBe("failed");
    expect(s4?.credentialForwardingAllowed).toBe(false);
  });

  it("noteChildExit on an unknown identity is a no-op (undefined), never a throw", () => {
    const sup = new PeerTransportSupervisor({ factory: trackingFactory(), identityProbe: matchingProbe });
    expect(sup.noteChildExit("sha256:ghost")).toBeUndefined();
  });
});

// ── AC4: identity mismatch suspends and forwards no credential ───────────────

describe("AC4 — target identity mismatch suspends the transport and does not forward credentials", () => {
  it("a mismatched endpoint identity → suspended, credential NEVER forwarded, handle torn down", async () => {
    const factory = trackingFactory();
    let forwarded = 0;
    const sup = new PeerTransportSupervisor({
      factory,
      identityProbe: async () => "sha256:IMPOSTER", // answers a DIFFERENT key than the peer's
      forwardCredential: () => {
        forwarded += 1;
      },
    });

    const s = await sup.connect(peer({ identityKey: "sha256:REAL" }));

    expect(s.status).toBe("suspended");
    expect(s.credentialForwardingAllowed).toBe(false);
    expect(sup.canForwardCredential("sha256:REAL")).toBe(false);
    expect(forwarded).toBe(0); // no nonce/credential ever crossed to an unverified endpoint
    expect(factory.handles[0].stopped).toBe(true); // the untrusted forward was torn down
  });

  it("an unverifiable endpoint (no observed identity) is also suspended with no credential forwarded", async () => {
    const factory = trackingFactory();
    let forwarded = 0;
    const sup = new PeerTransportSupervisor({
      factory,
      identityProbe: async () => undefined, // could-not-verify
      forwardCredential: () => {
        forwarded += 1;
      },
    });
    const s = await sup.connect(peer());
    expect(s.status).toBe("suspended");
    expect(forwarded).toBe(0);
  });

  it("a verified endpoint DOES forward the credential exactly once and is healthy", async () => {
    const factory = trackingFactory();
    let forwarded = 0;
    const sup = new PeerTransportSupervisor({
      factory,
      identityProbe: matchingProbe,
      forwardCredential: () => {
        forwarded += 1;
      },
    });
    const s = await sup.connect(peer({ identityKey: "sha256:REAL" }));
    expect(s.status).toBe("healthy");
    expect(s.credentialForwardingAllowed).toBe(true);
    expect(forwarded).toBe(1);
  });
});

// ── AC5: endpoint rotation observed dynamically, no silent Control restore ───

describe("AC5 — endpoint rotation is observed dynamically and never silently restores Control", () => {
  it("a rotated endpoint closes the credential gate and re-observing the rotated endpoint never reopens it", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });
    const s0 = await sup.connect(peer({ identityKey: "sha256:K" }));
    expect(s0.status).toBe("healthy");
    expect(s0.credentialForwardingAllowed).toBe(true);
    const verified = s0.verifiedEndpoint;
    expect(verified).toBe(s0.localUrl);

    // observing the SAME endpoint is a no-op — still healthy, gate open
    const same = sup.observeEndpoint("sha256:K", verified!);
    expect(same?.status).toBe("healthy");
    expect(same?.credentialForwardingAllowed).toBe(true);

    // the endpoint ROTATES to a new loopback URL (observed dynamically)
    const rotated = sup.observeEndpoint("sha256:K", "http://127.0.0.1:59999");
    expect(rotated?.credentialForwardingAllowed).toBe(false); // Control NOT silently restored
    expect(rotated?.status).toBe("reconnecting");
    expect(rotated?.localUrl).toBe("http://127.0.0.1:59999"); // observed dynamically, not persisted
    expect(rotated?.verifiedEndpoint).toBeUndefined(); // nothing currently verified on the new endpoint

    // re-observing the rotated endpoint does NOT reopen the gate — no silent restore
    const again = sup.observeEndpoint("sha256:K", "http://127.0.0.1:59999");
    expect(again?.credentialForwardingAllowed).toBe(false);
    expect(sup.canForwardCredential("sha256:K")).toBe(false);
  });

  it("only an explicit re-verify (re-connect, re-running the identity pin) restores Control after rotation", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });
    await sup.connect(peer({ identityKey: "sha256:K" }));
    sup.observeEndpoint("sha256:K", "http://127.0.0.1:59999");
    expect(sup.canForwardCredential("sha256:K")).toBe(false);

    const re = await sup.connect(peer({ identityKey: "sha256:K" })); // explicit re-verify
    expect(re.status).toBe("healthy");
    expect(re.credentialForwardingAllowed).toBe(true);
  });
});

// ── AC6: legacy hub tunnel + single-attachment lifecycle retain compatibility ─

describe("AC6 — the legacy hub/client tunnel and single-attachment lifecycle retain their responsibilities", () => {
  it("the hub tunnel forward argv is byte-stable: 127.0.0.1:PORT:127.0.0.1:PORT (same-port loopback)", () => {
    // The legacy hub tunnel is a single same-port loopback forward — unchanged
    // by this additive supervisor.
    expect(sshForwardArgs({ alias: "hub-host", port: 43117 })).toContain("127.0.0.1:43117:127.0.0.1:43117");
  });

  it("a peer transport is NOT the hub tunnel: an INDEPENDENT local port bound to loopback, distinct from the remote", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe, remotePort: 43117 });
    const a = await sup.connect(peer({ identityKey: "sha256:A" }));

    // the peer forward uses the per-attachment argv shape (independent
    // local/remote ports), NOT the hub tunnel's fixed same-port convention
    const args = attachmentForwardArgs({ alias: "a@h", localPort: a.localPort!, remotePort: 43117 });
    expect(a.localPort).not.toBe(43117); // independent local port — not the hub's same-port tunnel
    expect(args).toContain(`127.0.0.1:${a.localPort}:127.0.0.1:43117`);
    expect(a.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:/); // still loopback-bound
  });

  it("the supervisor manages N peers additively — it neither replaces nor requires the single-attachment lifecycle", async () => {
    const factory = trackingFactory();
    const sup = new PeerTransportSupervisor({ factory, identityProbe: matchingProbe });
    await sup.connect(peer({ identityKey: "sha256:A" }));
    await sup.connect(peer({ identityKey: "sha256:B" }));
    expect(sup.list().length).toBe(2); // N-peer, distinct from the one-active-target lifecycle
  });
});
