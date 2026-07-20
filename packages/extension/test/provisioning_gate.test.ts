// Mutation tests for the provisioning gate (the cli_gate.test.ts idiom):
// prove the gate REDS in the directions it exists to guard, without network —
// the positive venv+pip lane runs for real in both CI lanes.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — dual-mode .mjs gate script, imported for its exports (cli_gate idiom)
import { pinnedPasqalCloudVersion, runGate } from "../scripts/assert_provisioned_python.mjs";

function assetsDirWith(requirements: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "pasqal-gate-assets-"));
  mkdirSync(dir, { recursive: true });
  if (requirements !== undefined) writeFileSync(join(dir, "requirements.txt"), requirements);
  writeFileSync(join(dir, "pasqal_validate.py"), "import sys; sys.exit(1)\n");
  return dir;
}

describe("pinnedPasqalCloudVersion", () => {
  it("parses only an exact == pin; ranges/absence/comments fail safe", () => {
    const dir = assetsDirWith("pasqal-cloud==0.23.0\n");
    expect(pinnedPasqalCloudVersion(join(dir, "requirements.txt"))).toBe("0.23.0");
    for (const bad of ["pasqal-cloud>=0.23\n", "# pasqal-cloud==0.23.0 someday\npulser==1.8.0\n", ""]) {
      const d = assetsDirWith(bad);
      expect(pinnedPasqalCloudVersion(join(d, "requirements.txt")), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("runGate — fail-closed reds (no network)", () => {
  it("unpinned requirements red the pin lane AND every downstream lane (skipped-as-fail, never a pass)", async () => {
    const results = await runGate({ assetsDir: assetsDirWith("pasqal-cloud>=0.23\n") });
    const byName = Object.fromEntries(results.map((r: { check: string; ok: boolean }) => [r.check, r.ok]));
    expect(byName).toEqual({ pin: false, "venv+pip": false, "sdk-import": false, validator: false });
  });

  it("missing requirements.txt entirely: same fail-closed shape", async () => {
    const results = await runGate({ assetsDir: assetsDirWith(undefined) });
    expect(results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
  });
});
