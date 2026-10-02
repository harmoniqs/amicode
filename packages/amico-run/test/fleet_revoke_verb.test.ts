// fleet_revoke_verb.test.ts (#1438, ADR 0032 §D5) — `amico fleet revoke
// <machine_id>`: LOCAL expulsion (drop the issued grant + add the mint-list
// bar, on this machine's own registry) PLUS the fan-out to every serving peer
// (each peer applies it to its own registry; no machine writes another's).
//
// A NEW suite, sibling of fleet_enroll_verb.test.ts. The registry file I/O is
// exercised for real on a temp file; the fan-out is injected so the
// orchestration is asserted without a live mesh.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetRevoke, type FleetRevokeDeps, type ServingPeer } from "../src/fleet_revoke_verb.js";

interface RevokeJson {
  verb: string;
  subcommand: string;
  ok: boolean;
  machine_id?: string;
  revoked_local?: boolean;
  fanned_out?: Array<{ peer: string; ok: boolean; error?: string }>;
  errors?: string[];
}
const j = (r: { json: unknown }): RevokeJson => r.json as RevokeJson;

function tmpRegistry(seed?: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "amico-revoke-")), "fleet-peer-tokens.json");
  if (seed !== undefined) {
    require("node:fs").writeFileSync(file, JSON.stringify(seed, null, 2));
  }
  return file;
}

describe("amico fleet revoke <machine_id> (#1438, ADR 0032 §D5)", () => {
  it("requires a machine_id argument", async () => {
    const r = await fleetRevoke([], { registryFile: tmpRegistry() });
    expect(r.code).not.toBe(0);
    expect(j(r).ok).toBe(false);
  });

  it("LOCAL expulsion: drops the issued grant AND writes the mint-list bar on this machine's registry", async () => {
    const file = tmpRegistry({
      store_version: 1,
      issued: { evil: { token: "T", scope: "full-session", issued_at: "x" } },
      revoked: {},
    });
    const r = await fleetRevoke(["evil"], { registryFile: file, listServingPeers: async () => [] });
    expect(r.code).toBe(0);
    expect(j(r).revoked_local).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8")) as { issued: Record<string, unknown>; revoked: Record<string, unknown> };
    expect(doc.issued.evil).toBeUndefined(); // dropped
    expect(doc.revoked.evil).toBeDefined(); // barred (the mint-list bar)
  });

  it("FANS OUT to every serving peer (each peer applies it to its own registry)", async () => {
    const calls: Array<{ peer: string; machineId: string }> = [];
    const peers: ServingPeer[] = [
      { machine_id: "p1", origin: "http://p1:43117" },
      { machine_id: "p2", origin: "http://p2:43117" },
    ];
    const deps: FleetRevokeDeps = {
      registryFile: tmpRegistry({ store_version: 1, issued: {}, revoked: {} }),
      listServingPeers: async () => peers,
      fanOutRevoke: async (peer, machineId) => {
        calls.push({ peer: peer.origin, machineId });
        return { peer: peer.origin, ok: true };
      },
    };
    const r = await fleetRevoke(["evil"], deps);
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.peer).sort()).toEqual(["http://p1:43117", "http://p2:43117"]);
    expect(calls.every((c) => c.machineId === "evil")).toBe(true);
    expect(j(r).fanned_out?.length).toBe(2);
    expect(j(r).fanned_out?.every((f) => f.ok)).toBe(true);
  });

  it("a fan-out failure to one peer is reported (not swallowed), local revoke still applied", async () => {
    const file = tmpRegistry({ store_version: 1, issued: { evil: { token: "T" } }, revoked: {} });
    const r = await fleetRevoke(["evil"], {
      registryFile: file,
      listServingPeers: async () => [{ machine_id: "p1", origin: "http://p1" }],
      fanOutRevoke: async () => ({ peer: "http://p1", ok: false, error: "unreachable" }),
    });
    // local expulsion is authoritative for THIS machine and always applies
    expect(j(r).revoked_local).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8")) as { revoked: Record<string, unknown> };
    expect(doc.revoked.evil).toBeDefined();
    // the failed peer is surfaced honestly
    expect(j(r).fanned_out?.some((f) => !f.ok && f.error === "unreachable")).toBe(true);
  });
});
