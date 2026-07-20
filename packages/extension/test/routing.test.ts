import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCompanyComputeStatus,
  readCompanyComputeStatus,
  buildRoutingSection,
  COMPANY_COMPUTE_ID,
} from "../src/routing";

const tmpFile = (name: string, contents: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "conn-")), name);
  writeFileSync(f, contents);
  return f;
};

describe("parseCompanyComputeStatus", () => {
  it("cache-file shape: a connected company-compute entry → connected + identity echo", () => {
    const s = parseCompanyComputeStatus({
      [COMPANY_COMPUTE_ID]: { state: "connected", identity: "kate@harmoniqs.co", validated_at: "2026-07-20T00:00:00Z" },
    });
    expect(s).toEqual({ connected: true, identity: "kate@harmoniqs.co" });
  });

  it("route-body shape ({connections:[…]}) is understood too", () => {
    const s = parseCompanyComputeStatus({
      ok: true,
      connections: [{ id: COMPANY_COMPUTE_ID, state: "connected", identity: "sub-1" }],
      error: null,
    });
    expect(s).toEqual({ connected: true, identity: "sub-1" });
  });

  it("any non-connected state → not connected (needs-key / expired / invalid)", () => {
    for (const state of ["needs-key", "expired", "invalid", "unreachable", "validating"]) {
      expect(parseCompanyComputeStatus({ [COMPANY_COMPUTE_ID]: { state } }).connected).toBe(false);
    }
  });

  it("absent company-compute entry, non-object, and array all fail safe to not-connected", () => {
    expect(parseCompanyComputeStatus({ "pasqal-cloud": { state: "connected" } }).connected).toBe(false);
    expect(parseCompanyComputeStatus(null).connected).toBe(false);
    expect(parseCompanyComputeStatus("nope").connected).toBe(false);
    expect(parseCompanyComputeStatus([]).connected).toBe(false);
  });

  it("never surfaces a token or any non-whitelisted field, even if the cache is poisoned", () => {
    const s = parseCompanyComputeStatus({
      [COMPANY_COMPUTE_ID]: { state: "connected", identity: "me", token: "SECRET-TOKEN", base_url: "https://x" },
    });
    expect(s).toEqual({ connected: true, identity: "me" });
    expect(JSON.stringify(s)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(s)).not.toContain("base_url");
  });
});

describe("readCompanyComputeStatus", () => {
  it("reads a connected status from the non-secret cache file", () => {
    const f = tmpFile(
      "connections.json",
      JSON.stringify({ [COMPANY_COMPUTE_ID]: { state: "connected", identity: "me" } }),
    );
    expect(readCompanyComputeStatus(f)).toEqual({ connected: true, identity: "me" });
  });
  it("absent / corrupt file → not connected, never a throw", () => {
    expect(readCompanyComputeStatus(join(tmpdir(), "does-not-exist-xyz.json")).connected).toBe(false);
    const bad = tmpFile("connections.json", "{ not json");
    expect(readCompanyComputeStatus(bad).connected).toBe(false);
  });
});

describe("buildRoutingSection", () => {
  it("connected + hp → teaches the per-solve explicit confirm, estimator-suggests, executor:remote", () => {
    const s = buildRoutingSection({ solverMode: "hp", connected: true, identity: "kate@harmoniqs.co" });
    expect(s).toMatch(/amico-run estimate/);
    expect(s).toMatch(/PER-SOLVE/);
    expect(s).toMatch(/never auto-route/i);
    expect(s).toMatch(/offloadSuggested/); // the estimate drives the DEFAULT
    expect(s).toMatch(/sizeClass/); // surface the estimate at the decision point
    expect(s).toMatch(/executor.*"remote"/); // the choice the SolveSpec carries
    expect(s).toMatch(/connected as kate@harmoniqs\.co/); // the "connected as" echo
    expect(s).toMatch(/key entry never (routes|auto-routes)/i); // 7/19 design note
  });

  it("connected without an identity echo → offers remote but omits the 'connected as' line", () => {
    const s = buildRoutingSection({ solverMode: "hp", connected: true });
    expect(s).toMatch(/amico-run estimate/);
    expect(s).not.toMatch(/connected as/);
  });

  it("connected but solver mode is piccolo → no remote offer (mode gate)", () => {
    expect(buildRoutingSection({ solverMode: "piccolo", connected: true, identity: "me" })).toBe("");
  });

  it("hp mode but NOT connected → no remote offer (connection gate; disconnect ≠ mode)", () => {
    expect(buildRoutingSection({ solverMode: "hp", connected: false })).toBe("");
  });
});
