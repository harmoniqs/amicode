// fleet_projection.test.ts — the TS projection reader (amicode#1068, fleet
// rearchitect P3b-1): the amicode-side consumer of amicissimo's fleet-authority
// projection (contract v1, schema v1). The FORMAT is owned by amicissimo's
// fleet_authority package (Python, amicissimo#412/#413, READ-ONLY reference at
// the sibling worktree) — this suite pins the TS reader against the SAME
// rejection semantics the Python contract module pins (`read_projection`,
// `freshness_between`): a versioned, loud, never-silently-coerced read.
//
// The three properties this suite exists to defend:
//   1. THE CONTRACT IS VERSIONED AND THE REJECTION IS LOUD. A projection
//      carrying a stale, future, or absent contract_version is refused with a
//      message naming BOTH the seen version and this consumer's v1 — never
//      assumed current, never coerced (spec invariant 5).
//   2. FRESHNESS IS PUBLISHER-COMPUTED AND EPOCH-BOUND (spec §3 D1). Same
//      epoch + higher counter = fresh; equal = stale; cross-epoch or rewind =
//      unknown — force refetch, surfaced, never a false-fresh badge. The reader
//      NEVER computes age from a wall clock: it renders the carried fields
//      only (pinned by a source guard — the module has no Date at all).
//   3. PROVENANCE RENDERS BESIDE THE DATA, NEVER MERGED INTO IT. Every
//      section's source + parsed_from render as metadata; a section's value
//      is exactly what the publisher carried, never with provenance folded in.
//
// Fixture shapes are modeled on the Python tests' fixtures
// (tests/fleet_authority/ in amicissimo): the same epoch UUIDs, the same
// base-default discipline (mode absent = standalone, posture absent = ok).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FLEET_CONTRACT_VERSION,
  SUPPORTED_PROJECTION_SCHEMA_VERSIONS,
  MODE_VOCABULARY,
  POSTURE_VOCABULARY,
  FleetContractVersionError,
  readProjection,
  freshnessBetween,
  freshnessAdvisory,
  renderFleetStatus,
  fleetProjectionCachePath,
  FLEET_PROJECTION_CACHE_RELPATH,
  fleetTopologyPath,
  FLEET_TOPOLOGY_RELPATH,
  type FleetProjection,
} from "../src/fleet_projection.js";

// The Python contract tests' epochs (test_contract.py) — the same UUIDs, so a
// cross-repo reader can be diffed against the authority's own fixtures.
const E1 = "44444444-4444-4444-8444-444444444444";
const E2 = "55555555-5555-4555-8555-555555555555";

function proj(epoch: string, counter: number): FleetProjection {
  return {
    schema_version: 1,
    contract_version: 1,
    freshness: { hub_epoch: epoch, counter },
    sections: {},
  } as FleetProjection;
}

// A full projection, shaped on the Python publisher tests' output given the
// fleet_topology.json + fleet_health.json fixtures (client role → fleet mode).
const FULL = {
  schema_version: 1,
  contract_version: 1,
  publisher: { identity: "test-publisher", published_at: "2026-09-13T12:00:00Z" },
  freshness: { counter: 4, hub_epoch: "33333333-3333-4333-8333-333333333333" },
  sections: {
    mode: {
      value: "fleet",
      provenance: { source: "fleet.json", parsed_from: "role='client' (vocabulary mapping)" },
    },
    posture: {
      value: "ok",
      provenance: { source: "fleet-status.json", parsed_from: "base default (posture absent = ok)" },
    },
    topology: {
      value: {
        role: "client",
        canonical: { host: "hq-hub-01.example.internal", port: 4096, sshAlias: "hq-hub-01" },
        previousBinary: "/home/example/.amico/server/bin/opencode",
        previousPort: 4096,
      },
      provenance: {
        source: "fleet.json",
        parsed_from: "topology schema v1 fields: role, canonical, previousBinary, previousPort",
      },
    },
    health: {
      value: {
        collected_at: "2026-08-30T22:10:04Z",
        devices: [
          { name: "atom-01", reachable: true, detail: "this machine" },
          { name: "ion-02", reachable: false, detail: "ssh failed" },
        ],
      },
      provenance: { source: "fleet-status.json", parsed_from: "fields: collected_at, devices[2]" },
    },
    locks: {
      value: { rows: [{ session: "ses_0183f2", holder: "atom-01", leased_until: "2026-08-30T23:10:04Z" }] },
      provenance: { source: "hub lock state", parsed_from: "rendered from hub lock state: 1 row(s) — a rendering, never the enforcement" },
    },
  },
};

// ── the contract is versioned, and says so ───────────────────────────────────

describe("the fleet projection contract (v1)", () => {
  it("is at v1 with schema v1, mirroring the Python contract module's constants", () => {
    expect(FLEET_CONTRACT_VERSION).toBe(1);
    expect(SUPPORTED_PROJECTION_SCHEMA_VERSIONS).toEqual([1]);
  });

  it("carries the post-amendment mode + posture vocabularies", () => {
    expect(MODE_VOCABULARY).toEqual(["standalone", "fleet"]);
    expect(POSTURE_VOCABULARY).toEqual(["ok", "degraded", "hub-down"]);
  });
});

// ── the read entry point: loud, version-checking, never coerced ─────────────

describe("readProjection", () => {
  it("accepts a current projection unchanged (in-memory dict)", () => {
    const r = readProjection(FULL);
    expect(r.contract_version).toBe(1);
    expect(((r.sections ?? {}).mode as { value: unknown }).value).toBe("fleet");
  });

  it("reads a projection from a file path", () => {
    const r = readProjection(fileURLToPath(new URL("./fixtures/fleet_projection.json", import.meta.url)));
    expect(r.schema_version).toBe(1);
    expect(((r.sections ?? {}).posture as { value: unknown }).value).toBe("degraded");
  });

  it("a STALE contract version is rejected loudly, naming BOTH versions", () => {
    expect(() => readProjection({ schema_version: 1, contract_version: 0, sections: {} })).toThrowError(FleetContractVersionError);
    try {
      readProjection({ schema_version: 1, contract_version: 0, sections: {} });
      expect.unreachable("stale contract_version must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetContractVersionError);
      const msg = (e as Error).message;
      expect(msg).toContain("v0"); // the seen version, named
      expect(msg).toContain(`v${FLEET_CONTRACT_VERSION}`); // this consumer's version, named
    }
  });

  it("a FUTURE contract version is rejected loudly too, never silently coerced", () => {
    try {
      readProjection({ schema_version: 1, contract_version: 2, sections: {} });
      expect.unreachable("future contract_version must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetContractVersionError);
      expect((e as Error).message).toContain("v2");
      expect((e as Error).message).toContain(`v${FLEET_CONTRACT_VERSION}`);
    }
  });

  it("an ABSENT contract version is rejected loudly, never assumed current", () => {
    try {
      readProjection({ schema_version: 1, sections: {} });
      expect.unreachable("absent contract_version must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetContractVersionError);
      const msg = (e as Error).message;
      expect(msg).toContain("absent");
      expect(msg).toContain(`v${FLEET_CONTRACT_VERSION}`);
    }
  });

  it("an unknown schema_version is rejected loudly (before section data is trusted)", () => {
    expect(() => readProjection({ schema_version: 99, contract_version: 1, sections: {} })).toThrowError(/schema_version/);
  });

  it("a non-object projection document is rejected, never coerced into one", () => {
    expect(() => readProjection([1, 2, 3] as unknown as Record<string, unknown>)).toThrowError(/not a JSON object/);
  });
});

// ── freshness semantics: publisher-computed, epoch-bound, never wall-clock ───

describe("freshnessBetween (spec §3 D1)", () => {
  it("same epoch + higher counter = fresh", () => {
    expect(freshnessBetween(proj(E1, 3), proj(E1, 4))).toBe("fresh");
  });

  it("same epoch + equal counter = stale", () => {
    expect(freshnessBetween(proj(E1, 4), proj(E1, 4))).toBe("stale");
  });

  it("cross-epoch is ALWAYS unknown freshness, never silently fresh (the re-image case, both directions)", () => {
    expect(freshnessBetween(proj(E1, 5), proj(E2, 1))).toBe("unknown");
    expect(freshnessBetween(proj(E1, 1), proj(E2, 5))).toBe("unknown");
  });

  it("a counter that went BACKWARDS within one epoch is unknown, not fresh", () => {
    expect(freshnessBetween(proj(E1, 5), proj(E1, 2))).toBe("unknown");
  });

  it("a first fetch has no previous, so it is fresh", () => {
    expect(freshnessBetween(null, proj(E1, 1))).toBe("fresh");
  });

  it("absent freshness envelope fields compare UNKNOWN, never a crash", () => {
    const bare = { schema_version: 1, contract_version: 1, sections: {} } as unknown as FleetProjection;
    expect(freshnessBetween(proj(E1, 1), bare)).toBe("unknown");
    expect(freshnessBetween(bare, proj(E1, 1))).toBe("unknown");
  });

  it("unknown freshness carries the force-refetch advisory; stale says so; fresh stays quiet", () => {
    expect(freshnessAdvisory("unknown")).toMatch(/force refetch/i);
    expect(freshnessAdvisory("stale")).toMatch(/stale/i);
    expect(freshnessAdvisory("fresh")).toBe("");
  });
});

// ── provenance renders beside the data, never merged into it ─────────────────

describe("renderFleetStatus (provenance rendering)", () => {
  it("renders every section's value with its source + parsed_from as separate metadata", () => {
    const out = renderFleetStatus(readProjection(FULL));
    expect(out).toContain("mode: fleet");
    expect(out).toContain("posture: ok");
    expect(out).toContain("source: fleet.json"); // the mode section's source
    expect(out).toContain("role='client' (vocabulary mapping)"); // its parsed_from
    expect(out).toContain("hub lock state"); // the locks section's source
    expect(out).toContain("a rendering, never the enforcement"); // its parsed_from
    expect(out).toContain("test-publisher"); // the publisher identity renders
  });

  it("never merges provenance into the value — the value carries exactly what the publisher carried", () => {
    const r = readProjection(FULL);
    const sections = r.sections ?? {};
    // the section object holds value + provenance as SEPARATE keys, only
    expect(Object.keys(sections.mode as Record<string, unknown>).sort()).toEqual(["provenance", "value"]);
    const topologyValue = (sections.topology as { value: Record<string, unknown> }).value;
    expect(topologyValue).not.toHaveProperty("provenance"); // metadata stays BESIDE
    expect(topologyValue).not.toHaveProperty("source");
    expect(topologyValue).not.toHaveProperty("parsed_from");
  });

  it("renders the carried freshness fields verbatim — counter + epoch, published_at as provenance, no computed age", () => {
    const out = renderFleetStatus(readProjection(FULL));
    expect(out).toContain("counter 4");
    expect(out).toContain("33333333-3333-4333-8333-333333333333");
    expect(out).toContain("2026-09-13T12:00:00Z"); // the carried published_at stamp
    expect(out).not.toMatch(/age|old|ago|minute|hour|second/i); // never wall-clock age
  });

  it("surfaces unknown freshness with the force-refetch advisory when a previous is given", () => {
    const out = renderFleetStatus(readProjection(FULL), proj("11111111-1111-4111-8111-111111111111", 99));
    expect(out).toMatch(/unknown freshness/i);
    expect(out).toMatch(/force refetch/i);
  });

  it("absent sections render the base defaults (mode = standalone, posture = ok), never invented values", () => {
    const out = renderFleetStatus(readProjection({ schema_version: 1, contract_version: 1, sections: {} }));
    expect(out).toMatch(/mode: standalone/);
    expect(out).toMatch(/base default/);
    expect(out).toMatch(/posture: ok/);
  });

  it("absent envelope fields render honestly — no crash, no invention", () => {
    const out = renderFleetStatus(readProjection({ schema_version: 1, contract_version: 1, sections: {} }));
    expect(out).toMatch(/freshness: absent/);
    expect(out).toMatch(/\(unstamped\)/);
  });
});

// ── D1's never-wall-clock rule, pinned at the source ─────────────────────────

describe("the reader never computes age from a wall clock (D1 source guard)", () => {
  it("the reader module has no Date/now reference at all — freshness renders carried fields only", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/fleet_projection.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/\bDate\b|\bnow\b|performance\.now|process\.hrtime/);
  });
});

// ── the stable projection-cache convention (#1106, fleet rearchitect P3b-2) ───

describe("the stable projection-cache path convention (#1106)", () => {
  it("fleetProjectionCachePath resolves the live-layout precedent: <home>/.amico/ops/fleet/projection.json", () => {
    expect(fleetProjectionCachePath("/home/tester")).toBe("/home/tester/.amico/ops/fleet/projection.json");
  });

  // #1194: the topology source the publisher's --topology flag consumes.
  it("fleetTopologyPath resolves beside the cache: <home>/.amico/ops/fleet/fleet.json (#1194)", () => {
    expect(fleetTopologyPath("/home/tester")).toBe("/home/tester/.amico/ops/fleet/fleet.json");
    expect(fleetTopologyPath()).toBe(join(homedir(), ".amico", "ops", "fleet", "fleet.json"));
    expect(FLEET_TOPOLOGY_RELPATH).toBe(join(".amico", "ops", "fleet", "fleet.json"));
  });

  it("the default home is the process home — the ONE path every consumer (verb, extension, guard) reads", () => {
    expect(fleetProjectionCachePath()).toBe(join(homedir(), ".amico", "ops", "fleet", "projection.json"));
  });

  it("the relpath constant is the documented convention (scripts and the extension compose it from $HOME)", () => {
    expect(FLEET_PROJECTION_CACHE_RELPATH).toBe(join(".amico", "ops", "fleet", "projection.json"));
  });
});
