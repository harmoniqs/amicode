import { describe, it, expect } from "vitest";
import { probeCommand, formatHealthReport, type HealthResult } from "../src/healthcheck";

describe("formatHealthReport", () => {
  it("summarizes all-ok", () => {
    const r = formatHealthReport([
      { name: "Julia", ok: true, detail: "loads" },
      { name: "opencode server", ok: true, detail: "up" },
    ]);
    expect(r.allOk).toBe(true);
    expect(r.summary).toContain("all systems go");
    expect(r.lines[0]).toBe("OK   Julia: loads");
  });

  it("counts + names the failures", () => {
    const results: HealthResult[] = [
      { name: "Julia", ok: false, detail: "Piccolo did not load" },
      { name: "opencode server", ok: true, detail: "up" },
      { name: "LLM creds", ok: false, detail: "no key" },
    ];
    const r = formatHealthReport(results);
    expect(r.allOk).toBe(false);
    expect(r.summary).toContain("2 issue(s)");
    expect(r.summary).toContain("Julia");
    expect(r.summary).toContain("LLM creds");
    expect(r.lines.filter((l) => l.startsWith("FAIL")).length).toBe(2);
  });
});

describe("probeCommand", () => {
  it("ok on exit 0", async () => {
    const r = await probeCommand("true", [], 5000);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it("not ok on non-zero exit", async () => {
    const r = await probeCommand("false", [], 5000);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
  });

  it("not ok (with err) when the command can't spawn", async () => {
    const r = await probeCommand("amicode-no-such-binary-xyz", [], 5000);
    expect(r.ok).toBe(false);
    expect(r.err).toBeTruthy();
  });

  it("not ok on timeout (and kills the child)", async () => {
    const r = await probeCommand("sleep", ["10"], 150);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("timed out");
  });
});
