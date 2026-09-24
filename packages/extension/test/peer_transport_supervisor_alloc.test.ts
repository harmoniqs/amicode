// peer_transport_supervisor_alloc.test.ts — #1479 (ADR 0034, Fleet Studio
// completion): the PURE core of the managed per-peer transport supervisor —
// loopback endpoint ALLOCATION (AC1 + the "occupied ports" testing decision)
// and endpoint IDENTITY verification (AC4 + AC5's re-verify core). No network,
// no processes — pure functions, so the supervisor's collision-avoidance and
// its identity pin are provable without a real ssh forward (the real-forward
// path is exercised by the existing amicode_service_attachment_transport suite,
// reused rather than duplicated per the issue's Testing Decisions).
import { describe, it, expect } from "vitest";
import {
  allocateLoopbackPort,
  verifyEndpointIdentity,
  DEFAULT_LOCAL_PORT_BASE,
} from "../src/amicode_service/peer_transport_supervisor";

// ── AC1 + occupied ports: pure loopback endpoint allocation ──────────────────

describe("allocateLoopbackPort — pure distinct-endpoint allocation (#1479 AC1 + occupied ports)", () => {
  it("returns the base port when it is available", () => {
    expect(allocateLoopbackPort({ base: 43200, isAvailable: () => true })).toEqual({ ok: true, port: 43200 });
  });

  it("skips an OCCUPIED port and returns the next free one (the occupied-ports decision)", () => {
    const occupied = new Set([43200, 43201]);
    expect(
      allocateLoopbackPort({ base: 43200, isAvailable: (p) => !occupied.has(p) }),
    ).toEqual({ ok: true, port: 43202 });
  });

  it("two allocations that must not collide: the second treats the first as occupied → distinct ports", () => {
    const handedOut = new Set<number>();
    const first = allocateLoopbackPort({ base: 43200, isAvailable: (p) => !handedOut.has(p) });
    expect(first.ok).toBe(true);
    if (first.ok) handedOut.add(first.port);
    const second = allocateLoopbackPort({ base: 43200, isAvailable: (p) => !handedOut.has(p) });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.port).not.toBe(first.port);
  });

  it("is exhausted when nothing in the range is available — a NAMED not-ok, never a collision", () => {
    expect(allocateLoopbackPort({ base: 43200, range: 4, isAvailable: () => false })).toEqual({
      ok: false,
      reason: "exhausted",
    });
  });

  it("exposes a stable default base for the peer loopback band", () => {
    expect(typeof DEFAULT_LOCAL_PORT_BASE).toBe("number");
    expect(DEFAULT_LOCAL_PORT_BASE).toBeGreaterThan(1024);
  });
});

// ── AC4 + AC5 core: endpoint identity verification (the pin check) ───────────

describe("verifyEndpointIdentity — the stable-identity pin check (#1479 AC4/AC5)", () => {
  it("a matching fingerprint verifies", () => {
    expect(verifyEndpointIdentity("sha256:abc", "sha256:abc")).toEqual({ ok: true });
  });

  it("a DIFFERENT fingerprint is a mismatch — never silently accepted", () => {
    expect(verifyEndpointIdentity("sha256:abc", "sha256:xyz")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("an absent/blank observed identity is UNVERIFIED (could-not-verify is refused, per the binding amendment)", () => {
    expect(verifyEndpointIdentity("sha256:abc", undefined)).toEqual({ ok: false, reason: "unverified" });
    expect(verifyEndpointIdentity("sha256:abc", "   ")).toEqual({ ok: false, reason: "unverified" });
  });

  it("an absent expected identity is UNVERIFIED (never verify against nothing)", () => {
    expect(verifyEndpointIdentity("", "sha256:abc")).toEqual({ ok: false, reason: "unverified" });
  });
});
