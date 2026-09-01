// SEAM 6 (#703) — the plugin twin's warrant-bounds validator is PINNED to the
// ONE definition. The definition of the bounds vocabulary (and the device
// datum's enum + documented semantics) is @amicode/schema's $defs.bounds; the
// core tool table validates against it via validateBounds(). The plugin
// transport cannot import bare package specifiers at runtime (opencode's
// embedded Bun — see ../opencode-plugin/ledger_client's sibling-module rules),
// so opencode-plugin/warrant_bounds.ts re-implements the contract
// dependency-free. This test is the pin: both validators run over the same
// corpus — every datum case included — and must agree on ok AND on the error
// strings, and the twin's DEVICE_DATUM must equal the schema's own enum.
// A second free-text definition that can drift silently is exactly what the
// one-autonomy-doctrine forbids.
import { describe, it, expect } from "vitest";
import { validateBounds } from "@amicode/schema";
import ledgerRecordSchema from "@amicode/schema/schemas/ledger-record.schema.json";
import { validateWarrantBounds, boundsRefusal, DEVICE_DATUM } from "../opencode-plugin/warrant_bounds";

const corpus: unknown[] = [
  // every legal shape
  {},
  { max_solves: 8 },
  { tier: "free" },
  { max_size_class: "SMALL" },
  { max_size_class: "MEDIUM" },
  ...DEVICE_DATUM.map((device) => ({ device })),
  { max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "none" },
  // the datum's rejection cases — device outside the enum
  ...["write", "read", "readwrite", "READ-ONLY", "", "none,ro", 3, null].map((device) => ({ device })),
  // the "no second knob" cases — unknown device-permission-shaped fields
  ...["device_access", "device_permissions", "device_profile", "device_rw", "hardware_access"].map((extra) => ({
    device: "ro",
    [extra]: "rw",
  })),
  { device_access: "rw" },
  // the other bounds' rejection cases (the twin must mirror the whole contract)
  { max_duration: "30m" },
  { max_solves: 1.5 },
  { max_solves: 0 },
  { max_size_class: "LARGE" },
  { tier: "" },
  { tier: 5 },
  { max_solves: "8" },
  // non-object shapes
  "lots",
  42,
  null,
  [],
];

describe("the plugin twin's warrant-bounds validator agrees with @amicode/schema (the one definition)", () => {
  it("agrees on ok and on the error strings, over the whole corpus", () => {
    for (const bounds of corpus) {
      const schema = validateBounds(bounds);
      const twin = validateWarrantBounds(bounds);
      expect(twin.ok, JSON.stringify(bounds)).toBe(schema.ok);
      // ajv's allErrors order vs the twin's object-iteration order can differ;
      // the contract is the same SET of field-precise errors
      expect([...twin.errors].sort(), JSON.stringify(bounds)).toEqual([...schema.errors].sort());
    }
  });

  it("the twin's DEVICE_DATUM mirrors the schema's device enum — growth breaks the pin", () => {
    const schemaEnum = (ledgerRecordSchema as unknown as {
      $defs: { bounds: { properties: { device: { enum: string[] } } } };
    }).$defs.bounds.properties.device.enum;
    expect([...DEVICE_DATUM]).toEqual(schemaEnum);
  });

  it("boundsRefusal names the schema package and the datum's one-knob rule", () => {
    const msg = boundsRefusal(["/device: must be one of (none, ro, rw)"]);
    expect(msg).toMatch(/@amicode\/schema/);
    expect(msg).toMatch(/autonomy datum \(one enum, no second knob\)/);
  });
});
