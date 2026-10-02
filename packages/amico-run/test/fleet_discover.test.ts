// fleet_discover.test.ts (#1320) — the read-only discovery helper that backs
// the `/create-a-fleet` orchestrator. `discoverFleetCandidates` is PURE: it
// takes already-gathered inputs (tailnet peers, parsed ~/.ssh/config hosts, the
// #1318 roster rows) and enumerates the candidate machines, deduped, mutating
// nothing. No filesystem, no network — the skill gathers the inputs; this helper
// only reasons over them. A NEW suite, sibling of fleet_enroll_verb.test.ts.
//
// Run: pnpm --filter @amicode/amico-run test fleet_discover
import { describe, it, expect } from "vitest";
import type { RosterRow } from "@amicode/schema";
import { discoverFleetCandidates } from "../src/fleet_discover.js";

/** Build a full, lawful RosterRow (#1318 shape) from a partial override. */
function rosterRow(over: Partial<RosterRow> & { machine_id: string }): RosterRow {
  return {
    machine_id: over.machine_id,
    name: over.name ?? over.machine_id,
    server_mode: over.server_mode ?? "client",
    capabilities: over.capabilities ?? [],
    sshAlias: over.sshAlias ?? "",
    transport: over.transport ?? "ssh",
    last_report: over.last_report ?? "2026-09-20T00:00:00.000Z",
    health: over.health ?? "reachable",
  };
}

describe("discoverFleetCandidates — enumeration", () => {
  it("enumerates a machine from each source, tagged with the source it came from", () => {
    const result = discoverFleetCandidates({
      tailnet: [{ hostName: "aurora", tailscaleIP: "100.64.0.1", online: true }],
      sshConfig: [{ alias: "borealis", hostName: "borealis.local" }],
      roster: [rosterRow({ machine_id: "cid", name: "cygnus", sshAlias: "cygnus", health: "reachable" })],
    });

    expect(result).toHaveLength(3);
    const byName = Object.fromEntries(result.map((c) => [c.name, c]));
    expect(byName.aurora.sources).toEqual(["tailnet"]);
    expect(byName.borealis.sources).toEqual(["ssh-config"]);
    expect(byName.cygnus.sources).toEqual(["roster"]);
  });
});

describe("discoverFleetCandidates — dedupe across sources", () => {
  it("folds one machine seen in all three sources into a single candidate, merging sources + reach hints", () => {
    const result = discoverFleetCandidates({
      // The same machine, named consistently across sources (tailnet HostName ==
      // ssh alias == roster name), with a MagicDNS suffix on the tailnet name to
      // exercise the first-DNS-label normalization.
      tailnet: [{ hostName: "mini.tail-abcd.ts.net.", tailscaleIP: "100.64.0.9", online: true }],
      sshConfig: [{ alias: "mini", hostName: "mini.local" }],
      roster: [rosterRow({ machine_id: "mini-id", name: "mini", sshAlias: "mini", health: "reachable" })],
    });

    expect(result).toHaveLength(1);
    const [c] = result;
    // sources deduped + in canonical order (roster, ssh-config, tailnet).
    expect(c.sources).toEqual(["roster", "ssh-config", "tailnet"]);
    expect(c.id).toBe("mini");
    // reach hints merged from whichever sources carried them.
    expect(c.sshAlias).toBe("mini");
    expect(c.address).toBe("100.64.0.9");
  });

  it("keeps distinct machines distinct even when some share a source", () => {
    const result = discoverFleetCandidates({
      tailnet: [
        { hostName: "mini", tailscaleIP: "100.64.0.9" },
        { hostName: "studio", tailscaleIP: "100.64.0.10" },
      ],
      sshConfig: [{ alias: "mini" }],
      roster: [],
    });
    expect(result.map((c) => c.id)).toEqual(["mini", "studio"]);
    expect(result.find((c) => c.id === "mini")!.sources).toEqual(["ssh-config", "tailnet"]);
    expect(result.find((c) => c.id === "studio")!.sources).toEqual(["tailnet"]);
  });
});

describe("discoverFleetCandidates — read-only (mutates nothing)", () => {
  /** Recursively freeze so ANY write to an input throws in strict mode. */
  function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  }

  it("does not read-through-and-write: frozen inputs survive, deep-equal to a pre-call snapshot", () => {
    const input = {
      tailnet: [{ hostName: "mini.tail-abcd.ts.net.", tailscaleIP: "100.64.0.9", online: true }],
      sshConfig: [{ alias: "mini", hostName: "mini.local" }],
      roster: [rosterRow({ machine_id: "mini-id", name: "mini", sshAlias: "mini", health: "reachable" })],
    };
    const snapshot = structuredClone(input);
    deepFreeze(input);

    // The call must not throw (no write to a frozen input) and must produce a result.
    const result = discoverFleetCandidates(input);
    expect(result.length).toBeGreaterThan(0);

    // The inputs are byte-for-byte what they were.
    expect(input).toEqual(snapshot);
  });
});

describe("discoverFleetCandidates — enrolled state + the simulated gap", () => {
  it("marks a machine enrolled ONLY when its roster row is healthy; a gap machine stays enumerated but unenrolled", () => {
    const result = discoverFleetCandidates({
      // hub: enrolled server (verify-attach passed → health reachable).
      // gap: discovered on the wire but NO roster row (no amicode / no link yet).
      // stuck: has a roster row but verify-attach FAILED (health down).
      tailnet: [
        { hostName: "hub", tailscaleIP: "100.64.0.1" },
        { hostName: "gap", tailscaleIP: "100.64.0.2" },
        { hostName: "stuck", tailscaleIP: "100.64.0.3" },
      ],
      sshConfig: [{ alias: "hub" }, { alias: "gap" }, { alias: "stuck" }],
      roster: [
        rosterRow({ machine_id: "hub-id", name: "hub", sshAlias: "hub", server_mode: "server", health: "reachable" }),
        rosterRow({ machine_id: "stuck-id", name: "stuck", sshAlias: "stuck", server_mode: "client", health: "down" }),
      ],
    });

    // guide-and-resume: the gap machine is NOT dropped — all three continue.
    expect(result.map((c) => c.id)).toEqual(["gap", "hub", "stuck"]);
    const byId = Object.fromEntries(result.map((c) => [c.id, c]));

    // hub: a healthy roster row → enrolled, with its role + health surfaced.
    expect(byId.hub).toMatchObject({ inRoster: true, enrolled: true, serverMode: "server", health: "reachable" });

    // gap: no roster row at all → never reported enrolled (nothing to verify yet).
    expect(byId.gap).toMatchObject({ inRoster: false, enrolled: false });
    expect(byId.gap.health).toBeUndefined();
    expect(byId.gap.serverMode).toBeUndefined();

    // stuck: a roster row exists but verify-attach failed → unenrolled until resolved.
    expect(byId.stuck).toMatchObject({ inRoster: true, enrolled: false, health: "down" });
  });

  it("a degraded roster row is also not enrolled (only `reachable` clears the honesty bar)", () => {
    const result = discoverFleetCandidates({
      roster: [rosterRow({ machine_id: "d-id", name: "deg", health: "degraded" })],
    });
    expect(result[0]).toMatchObject({ inRoster: true, enrolled: false, health: "degraded" });
  });
});
