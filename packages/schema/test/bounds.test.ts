// $defs.bounds + validateBounds — the WarrantBounds contract the spec-review `budget`
// lens reads. Exists so the lens checks an authored budget against the SHIPPED bound
// vocabulary rather than a prose restatement: the drift that let the long-removed
// `max_duration` into a spec example (plan-20260728 Task 1).
import { describe, it, expect } from "vitest";
import ledgerRecordSchema from "../schemas/ledger-record.schema.json" with { type: "json" };
import { validateBounds } from "../src/index.js";

// ── The autonomy datum (codesign SEAM 6, #703) ──────────────────────────────
// The device profile datum is THE single switch for what a warrant may do to a
// device — one enum, one definition (this schema), three documented meanings.
// These tests pin the datum's SHAPE as authored in the schema, because the
// criterion is the schema itself: the enum plus its documented semantics, and
// the three-systems contract stated once with each counterpart's criterion
// NAMED under its own owner (never claimed as this repo's).
describe("the device datum in $defs.bounds (SEAM 6 — one autonomy doctrine)", () => {
  const device = (ledgerRecordSchema as unknown as {
    $defs: { bounds: { properties: { device: { enum: string[]; description: string } } } };
  }).$defs.bounds.properties.device;

  it("is the enum {none, ro, rw} — exactly three states, no free string", () => {
    expect(device.enum).toEqual(["none", "ro", "rw"]);
  });

  it("documents the three meanings (none / ro / rw) and the rw human gate", () => {
    const d = device.description;
    // none = no device access
    expect(d).toMatch(/none.*no device access/);
    // ro = read-only device access
    expect(d).toMatch(/ro.*read-only/);
    // rw = device writes permitted, gated by the real-board-session human gate
    expect(d).toMatch(/rw.*device writes/);
    expect(d).toMatch(/real-board session|human gate/);
  });

  it("states the three-systems contract once, each counterpart criterion NAMED under its owner", () => {
    const d = device.description;
    // amicode's half is THIS schema (the one definition); the counterpart reads
    // are merge-gated follow-ons owned elsewhere — named, not claimed here.
    expect(d).toMatch(/strumento #75/);
    expect(d).toMatch(/Telaio/);
  });
});

describe("validateBounds", () => {
  it("accepts every legal key", () => {
    expect(validateBounds({ max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "none" }).ok).toBe(true);
  });
  it("accepts an empty object (every bound optional)", () => {
    expect(validateBounds({}).ok).toBe(true);
  });
  it("REJECTS max_duration — removed by G-8, and the exact key a spec author reaches for", () => {
    const r = validateBounds({ max_duration: "30m" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/max_duration/);
  });
  it("rejects an out-of-enum size class", () => {
    expect(validateBounds({ max_size_class: "LARGE" }).ok).toBe(false);
  });
  it("rejects a non-integer max_solves", () => {
    expect(validateBounds({ max_solves: 1.5 }).ok).toBe(false);
  });
});

// The rejection half of the autonomy datum (codesign SEAM 6, #703): the datum
// is one knob, and warrant-bounds parsing must REFUSE a second one — any device
// value outside the enum, and any unknown device-permission-shaped field
// riding alongside a (valid) `device`. Silently ignoring a second knob is how
// three systems grow three switches.
describe("validateBounds — the device datum's rejection semantics (no second knob)", () => {
  it("accepts each of the datum's three states on its own", () => {
    for (const device of ["none", "ro", "rw"]) {
      expect(validateBounds({ device }).ok, device).toBe(true);
    }
  });

  it("REFUSES any device value outside the enum — not a free string", () => {
    for (const bad of ["write", "read", "readwrite", "READ-ONLY", "", "none,ro"]) {
      const r = validateBounds({ device: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      // field-precise: the error names the offending key
      expect(r.errors.join(" ")).toMatch(/device/);
    }
  });

  it("REFUSES an unknown device-shaped field beside `device` — no second knob", () => {
    // the shapes a second device switch actually arrives in
    for (const extra of ["device_access", "device_permissions", "device_profile", "device_rw"]) {
      const r = validateBounds({ device: "ro", [extra]: "rw" });
      expect(r.ok, extra).toBe(false);
      // field-precise: the error names the IMPOSTOR key, not just "bounds"
      expect(r.errors.join(" "), extra).toMatch(new RegExp(extra.replace("_", "_")));
    }
  });

  it("REFUSES an unknown device-shaped field even alone (still not the datum)", () => {
    const r = validateBounds({ device_access: "rw" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/device_access/);
  });
});
