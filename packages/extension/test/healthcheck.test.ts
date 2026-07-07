import { describe, it, expect } from "vitest";
import { resolveChecks } from "../scripts/healthcheck.mjs";

const ok = { ok: true };
const bad = (reason: string, fix: string) => ({ ok: false, reason, fix });

describe("resolveChecks", () => {
  it("exit 0 when all four pass", () => {
    const r = resolveChecks({ julia: ok, opencode: ok, amicorun: ok, creds: ok });
    expect(r.exitCode).toBe(0);
    expect(r.lines.filter((l: string) => l.startsWith("✓"))).toHaveLength(4);
  });
  it("non-zero + precise line when one fails", () => {
    const r = resolveChecks({ julia: ok, opencode: bad("no /event 200", "check opencode"), amicorun: ok, creds: ok });
    expect(r.exitCode).not.toBe(0);
    expect(r.lines.join("\n")).toMatch(/✗ opencode \/event: no \/event 200 → check opencode/);
  });
  it("reports every failing check, not just the first", () => {
    const r = resolveChecks({ julia: bad("a", "x"), opencode: ok, amicorun: bad("b", "y"), creds: ok });
    expect(r.lines.filter((l: string) => l.startsWith("✗"))).toHaveLength(2);
  });
});
