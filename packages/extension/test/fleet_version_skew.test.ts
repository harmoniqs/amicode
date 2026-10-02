// fleet_version_skew.test.ts — #1261 (Slice 1) AC7: the version-skew RELAY-START
// gate (moved here from #1265 — it is a relay-start gate, protecting the
// host-API-shape assumptions #1262 / #1264 build on).
//
// The relay refuses to START (with an ACTIONABLE message, never a generic
// downstream timeout) when the client's pinned version and the host's version
// (GET /global/health → version) disagree beyond a defined tolerance; matching
// versions start cleanly.
//
// TOLERANCE (defined here, per the AC): semver MINOR — major.minor must agree,
// the patch may differ. `exact` (all three) and `major` (major only) are the
// other two selectable modes.
import { describe, it, expect } from "vitest";
import { versionSkewVerdict, relayVersionGate, hostVersionProbe } from "../src/amicode_service/fleet_version_skew";
import { startAmicodeService } from "../src/amicode_service_wiring";

describe("version-skew verdict (#1261 AC7) — the pure semver comparison", () => {
  it("default tolerance is MINOR: same major.minor with a differing patch AGREES", () => {
    const v = versionSkewVerdict("v1.18.29", "v1.18.30");
    expect(v.agree).toBe(true);
    expect(v.tolerance).toBe("minor");
  });

  it("identical versions agree", () => {
    expect(versionSkewVerdict("v1.18.29", "v1.18.29").agree).toBe(true);
  });

  it("a MINOR disagreement is refused (beyond the minor tolerance)", () => {
    const v = versionSkewVerdict("v1.18.29", "v1.19.0");
    expect(v.agree).toBe(false);
  });

  it("a MAJOR disagreement is refused", () => {
    expect(versionSkewVerdict("v1.18.29", "v2.0.0").agree).toBe(false);
  });

  it("tolerance `exact` refuses a patch difference; `major` tolerates a minor difference", () => {
    expect(versionSkewVerdict("v1.18.29", "v1.18.30", "exact").agree).toBe(false);
    expect(versionSkewVerdict("v1.18.29", "v1.19.0", "major").agree).toBe(true);
  });

  it("the refusal reason is ACTIONABLE — it names BOTH versions and how to fix (never a bare timeout)", () => {
    const v = versionSkewVerdict("v1.18.29", "v1.20.4");
    expect(v.agree).toBe(false);
    expect(v.reason).toContain("v1.18.29"); // the client pin
    expect(v.reason).toContain("v1.20.4"); // the host version
    expect(v.reason).toMatch(/upgrade|match|align/i); // a fix, not a timeout
    expect(v.reason).not.toMatch(/timeout/i);
  });

  it("an unparseable version falls back to strict string equality (no false agreement)", () => {
    expect(versionSkewVerdict("dev", "dev").agree).toBe(true);
    expect(versionSkewVerdict("dev", "v1.18.29").agree).toBe(false);
  });
});

describe("relay-start version gate (#1261 AC7) — start | refuse", () => {
  it("matching versions START cleanly", async () => {
    const r = await relayVersionGate({ clientPin: "v1.18.29", probeHostVersion: async () => "v1.18.31" });
    expect(r.start).toBe(true);
  });

  it("a disagreement beyond tolerance REFUSES to start, with the actionable verdict reason", async () => {
    const r = await relayVersionGate({ clientPin: "v1.18.29", probeHostVersion: async () => "v1.19.0" });
    expect(r.start).toBe(false);
    expect(r.hostVersion).toBe("v1.19.0");
    expect(r.reason).toContain("v1.18.29");
    expect(r.reason).toContain("v1.19.0");
    expect(r.reason).not.toMatch(/timeout/i);
  });

  it("an unreadable host version (host down) does NOT masquerade as a skew refusal — the relay starts, hub-down handles it", async () => {
    const r = await relayVersionGate({ clientPin: "v1.18.29", probeHostVersion: async () => null });
    expect(r.start).toBe(true);
    expect(r.hostVersion).toBeNull();
  });

  it("hostVersionProbe reads GET /global/health → version, with a bounded timeout returning null on failure", async () => {
    const okProbe = hostVersionProbe(() => "http://host", "Basic x", {
      fetchImpl: (async () => new Response(JSON.stringify({ healthy: true, version: "v1.18.29" }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await okProbe()).toBe("v1.18.29");

    const noUrlProbe = hostVersionProbe(() => undefined, "Basic x");
    expect(await noUrlProbe()).toBeNull();

    const failProbe = hostVersionProbe(() => "http://host", "Basic x", {
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(await failProbe()).toBeNull();
  });
});

describe("relay-start version gate — WIRED into startAmicodeService (#1261 AC7)", () => {
  it("a skewed host REFUSES the relay boot: no service, the actionable reason logged", async () => {
    const lines: string[] = [];
    const boot = await startAmicodeService(
      { appendLine: (l) => lines.push(l) },
      { versionGate: { clientPin: "v1.18.29", probeHostVersion: async () => "v1.19.0" } },
    );
    expect(boot).toBeUndefined(); // the relay did not start
    const gateLog = lines.find((l) => l.includes("version"));
    expect(gateLog).toBeTruthy();
    expect(gateLog).toContain("v1.18.29");
    expect(gateLog).toContain("v1.19.0");
    expect(gateLog).not.toMatch(/generic timeout/i);
  });

  it("a matching host STARTS the relay cleanly", async () => {
    const boot = await startAmicodeService(
      { appendLine: () => undefined },
      { versionGate: { clientPin: "v1.18.29", probeHostVersion: async () => "v1.18.30" } },
    );
    expect(boot).toBeDefined();
    try {
      expect(boot!.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      await boot!.service.stop();
    }
  });

  it("an unreadable host version starts the relay (deferred to hub-down, never a false skew refusal)", async () => {
    const boot = await startAmicodeService(
      { appendLine: () => undefined },
      { versionGate: { clientPin: "v1.18.29", probeHostVersion: async () => null } },
    );
    expect(boot).toBeDefined();
    await boot!.service.stop();
  });
});

