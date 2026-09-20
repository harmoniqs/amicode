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
