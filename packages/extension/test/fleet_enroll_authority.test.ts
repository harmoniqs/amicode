// fleet_enroll_authority.test.ts — #1541 (ADR 0034 D3): the cross-package
// writer↔resolver contract for the NET-NEW lifecycle-admin authority.
//
// `amico fleet enroll` (in @amicode/amico-run) records the enroller as the
// enrolling machine's lifecycle-admin authority through a persisted, on-disk
// store (the shared @amicode/schema contract — amico-run writes, the extension
// reads, NOT a cross-package import). This suite proves the extension-side
// resolver resolves EXACTLY what the enroll-side writer wrote — the only place
// both halves of the contract can be exercised together (the extension depends
// on amico-run, so an extension test may drive both).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordLifecycleAuthority as schemaRecordLifecycleAuthority,
  type LifecycleAuthorityRecord,
} from "@amicode/schema";
import {
  fleetEnroll,
  type FleetEnrollDeps,
  type JoinToken,
} from "../../amico-run/src/fleet_enroll_verb.js";
import { resolveLifecycleAuthority } from "../src/amicode_service/fleet_lifecycle_authority";

function tmpStore(): string {
  return join(mkdtempSync(join(tmpdir(), "amicode-1541-authority-")), "fleet-lifecycle-authority.json");
}

// A fake fetch answering every hub probe (pin-check + roster POST + verify-attach)
// as a healthy, pin-matching host — so the client redeem runs end-to-end with no
// server standing.
const healthyFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({ healthy: true, version: "v1.18.29" }),
})) as unknown as typeof fetch;

function enrollDeps(store: string, over: Partial<FleetEnrollDeps> = {}): FleetEnrollDeps {
  return {
    machineId: () => "headless-target",
    machineName: () => "Headless Target",
    capabilities: () => [],
    clientVersion: () => "v1.18.29",
    now: () => "2026-09-24T00:00:00.000Z",
    fleetConfigPath: join(tmpdir(), "amicode-1541-nonexistent", "fleet.json"),
    writeFleetConfig: () => {},
    setTransport: () => {},
    runInstaller: () => ({ ok: true }),
    fetchImpl: healthyFetch,
    resolveProbeOrigin: () => ({ ok: true, origin: "http://hub.example:4096" }),
    retryDelayMs: [0, 0, 0],
    commandRunner: () => "",
    readDeviceSetting: () => undefined,
    // the writer under test: the REAL shared @amicode/schema writer the enroll
    // default uses, pointed at a hermetic tmp store.
    recordLifecycleAuthority: (rec: LifecycleAuthorityRecord) => schemaRecordLifecycleAuthority(rec, store),
    ...over,
  };
}

const token: JoinToken = {
  canonical: { host: "hub.example", port: 4096, sshAlias: "hub" },
  fleet_token: "FLEET-SECRET",
  transport_hint: "ssh",
  pin_version: "v1.18.29",
};

describe("#1541 AC1/AC4 — Enroll seeds a resolvable lifecycle-admin authority (writer↔resolver contract)", () => {
  it("a headless target that ran Enroll yields an authority the extension resolver resolves EXACTLY", async () => {
    const store = tmpStore();
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(token)], enrollDeps(store));
    expect(r.code).toBe(0);

    const resolved = resolveLifecycleAuthority("headless-target", { authorityStoreFile: store });
    expect(resolved).toBeDefined();
    expect(resolved!.targetMachineId).toBe("headless-target"); // the machine that ran Enroll (the target)
    expect(resolved!.authorityMachineId).toBe("hub.example"); // the enroller / canonical server
    expect(resolved!.authorityIdentityKey).toBe("hub.example");
    expect(typeof resolved!.recordedAt).toBe("string");
  });

  it("a machine that never enrolled has no resolvable authority (honest undefined, the target renders nothing)", () => {
    const store = tmpStore();
    expect(resolveLifecycleAuthority("never-enrolled", { authorityStoreFile: store })).toBeUndefined();
  });

  it("a second peer's authority is resolved independently — the store keys by target machine_id", async () => {
    const store = tmpStore();
    await fleetEnroll(["--join-token-json", JSON.stringify(token)], enrollDeps(store));
    await fleetEnroll(
      ["--join-token-json", JSON.stringify(token)],
      enrollDeps(store, { machineId: () => "second-target" }),
    );
    expect(resolveLifecycleAuthority("headless-target", { authorityStoreFile: store })!.authorityMachineId).toBe(
      "hub.example",
    );
    expect(resolveLifecycleAuthority("second-target", { authorityStoreFile: store })!.authorityMachineId).toBe(
      "hub.example",
    );
  });
});
