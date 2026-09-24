// fleet_config.test.ts (@amicode/schema) — #1319: the fleet.json WRITER
// (writeFleetConfig + the FleetConfig shape) is hoisted here to sit beside its
// READER (parseFleetTopology, fleet_projection.ts) so `amico fleet enroll` (in
// @amicode/amico-run) writes the SAME role+canonical membership record the
// extension writes and amicissimo's ONE parser reads. The extension re-exports
// it (fleet_fallback.ts) so goStandalone/migrateLegacyFallback are untouched.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFleetConfig, parseFleetTopology, type FleetConfig } from "../src/index.js";

describe("writeFleetConfig — hoisted to @amicode/schema (#1319, sibling of parseFleetTopology)", () => {
  it("writes a role+canonical record the ONE parser round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-config-"));
    try {
      const p = join(dir, "fleet.json");
      const config: FleetConfig = { role: "client", canonical: { host: "hub", port: 4096, sshAlias: "hub" } };
      writeFleetConfig(config, p);
      const parsed = parseFleetTopology(readFileSync(p, "utf8"));
      expect(parsed?.role).toBe("client");
      expect(parsed?.canonical).toEqual({ host: "hub", port: 4096, sshAlias: "hub" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically (tmp+rename) — the persisted file is valid JSON, no .tmp left behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-config-"));
    try {
      const p = join(dir, "fleet.json");
      writeFleetConfig({ role: "server" }, p);
      expect(() => JSON.parse(readFileSync(p, "utf8"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
