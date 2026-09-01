// SEAM 6 (#703) — the mint path's half of the tool-surface alignment. The
// approval card's bridge mints a warrant by shelling `amico ledger approve`
// through approveArgv (warrants.ts — "Exported for testing so the flag mapping
// is pinned"; this file is that pin). The bounds are validated against
// @amicode/schema's $defs.bounds (validateBounds) — the ONE definition — so a
// device value outside {none, ro, rw} or a second device-shaped field is
// REFUSED here rather than silently dropped: a dropped bound silently
// under-authorises the minted warrant, and a second knob is the drift the
// one-autonomy-doctrine forbids.
import { describe, it, expect } from "vitest";
import { approveArgv } from "../src/amicode_service/warrants";

describe("approveArgv — the flag mapping pinned (no spawn)", () => {
  it("maps every declared bound to its flag, device: rw included", () => {
    expect(
      approveArgv({
        plan_hash: "abc123",
        bounds: { max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "rw" },
        expires_in: 60,
      }),
    ).toEqual([
      "ledger",
      "approve",
      "--plan-hash",
      "abc123",
      "--max-solves",
      "8",
      "--tier",
      "free",
      "--max-size-class",
      "MEDIUM",
      "--device",
      "rw",
      "--expires-in",
      "60",
      "--issued-by",
      "user:ui",
    ]);
  });

  it("omits flags for bounds never declared — an omitted bound stays ABSENT (§5.1 rule 2)", () => {
    expect(approveArgv({ plan_hash: "abc123" })).toEqual(["ledger", "approve", "--plan-hash", "abc123", "--issued-by", "user:ui"]);
    expect(approveArgv({ plan_hash: "abc123", bounds: null })).toEqual([
      "ledger",
      "approve",
      "--plan-hash",
      "abc123",
      "--issued-by",
      "user:ui",
    ]);
  });

  it("requires plan_hash", () => {
    expect(approveArgv({ bounds: { device: "ro" } })).toEqual({ error: "plan_hash is required" });
  });
});

describe("approveArgv — bounds validate against the schema package's datum (SEAM 6)", () => {
  it("REFUSES a device value outside the enum — never silently dropped", () => {
    const r = approveArgv({ plan_hash: "abc123", bounds: { device: "write" } });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/device/);
    expect((r as { error: string }).error).toMatch(/none, ro, rw/);
  });

  it("REFUSES a second device-shaped knob riding beside the datum", () => {
    const r = approveArgv({ plan_hash: "abc123", bounds: { device: "ro", device_access: "rw" } });
    expect("error" in r).toBe(true);
    expect((r as { error: string }).error).toMatch(/device_access/);
  });

  it("REFUSES any other invalid bound the schema refuses (max_solves 1.5, LARGE)", () => {
    for (const bounds of [{ max_solves: 1.5 }, { max_size_class: "LARGE" }]) {
      const r = approveArgv({ plan_hash: "abc123", bounds });
      expect("error" in r, JSON.stringify(bounds)).toBe(true);
    }
  });
});
