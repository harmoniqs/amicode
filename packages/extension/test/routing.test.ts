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
  it("connected + hp → states the cloud-only contract and the hpc spec triple", () => {
    const s = buildRoutingSection({ solverMode: "hp", connected: true, identity: "kate@harmoniqs.co" });
    expect(s).toMatch(/CLOUD-ONLY/);
    expect(s).toMatch(/tier="hpc"/);
    expect(s).toMatch(/executor.*"remote"/);
    expect(s).toMatch(/env\.kind="provisioned"/);
    expect(s).toMatch(/Harmoniqs Cloud/);
    expect(s).toMatch(/connected as kate@harmoniqs\.co/); // the "connected as" echo
  });

  // The regression this section exists to prevent: it used to teach a per-solve
  // "local or cloud?" confirm, which contradicted the cloud-only tier sitting
  // beside it — and the agent resolved the contradiction by dispatching HP
  // solves LOCALLY (2026-07-20 precompile SIGTERMs). The routing question must
  // not come back for this solver.
  it("connected + hp → never asks the researcher where the solve runs", () => {
    const s = buildRoutingSection({ solverMode: "hp", connected: true });
    expect(s).not.toMatch(/PER-SOLVE/);
    expect(s).not.toMatch(/offloadSuggested/);
    expect(s).toMatch(/do NOT ask/i);
    // the estimate survives as reporting, explicitly stripped of its old
    // decision-making role
    expect(s).toMatch(/no longer decides/i);
  });

  it("connected without an identity echo → still cloud-only, omits the 'connected as' line", () => {
    const s = buildRoutingSection({ solverMode: "hp", connected: true });
    expect(s).toMatch(/CLOUD-ONLY/);
    expect(s).not.toMatch(/connected as/);
  });

  it("connected but solver mode is piccolo → no remote offer (mode gate)", () => {
    expect(buildRoutingSection({ solverMode: "piccolo", connected: true, identity: "me" })).toBe("");
  });

  it("hp mode but NOT connected → no remote offer (connection gate; disconnect ≠ mode)", () => {
    expect(buildRoutingSection({ solverMode: "hp", connected: false })).toBe("");
  });
});
