import { describe, it, expect } from "vitest";
import { probeCommand, formatHealthReport, probeOpencodeTui, type HealthResult } from "../src/healthcheck";

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

  it("appends timing + captured log (indented) for a failed check (#19)", () => {
    const r = formatHealthReport([
      { name: "Julia", ok: false, detail: "Piccolo did not load (exit 1)", ms: 4210, log: "ERROR: LoadError\nstack line 2" },
      { name: "opencode server", ok: true, detail: "up", ms: 1 },
    ]);
    // timing shown on the check line
    expect(r.lines[0]).toContain("(4210ms)");
    expect(r.lines.some((l) => l.includes("up  (1ms)"))).toBe(true);
    // the captured log is appended, indented, only for the failed check
    expect(r.lines).toContain("  | ERROR: LoadError");
    expect(r.lines).toContain("  | stack line 2");
  });

  it("does not append a log for a passing check even if one is present", () => {
    const r = formatHealthReport([{ name: "Julia", ok: true, detail: "loads", log: "noisy stdout" }]);
    expect(r.lines.some((l) => l.startsWith("  |"))).toBe(false);
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

  it("returns the first stderr line for a non-zero exit", async () => {
    const r = await probeCommand(
      process.execPath,
      ["-e", 'process.stderr.write("specific failure\\nstack detail\\n"); process.exit(7)'],
      5000,
    );
    expect(r).toEqual({
      ok: false,
      code: 7,
      err: "specific failure",
      output: "specific failure\nstack detail",
    });
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

  it("captures stdout+stderr output (#19) so failures are diagnosable", async () => {
    const r = await probeCommand("sh", ["-c", "echo out; echo boom >&2; exit 3"], 5000);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("boom");
  });
});

describe("probeOpencodeTui", () => {
  it("returns OK with resolved target path when symlink is healthy", () => {
    const result = probeOpencodeTui({
      lstatSync: () => ({ isSymbolicLink: () => true }),
      readlinkSync: () => "/home/user/.amico/opencode/canonical/current/opencode",
      accessSync: () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.name).toBe("opencode TUI");
    expect(result.detail).toContain("/home/user/.amico/opencode/canonical/current/opencode");
  });

  it("returns FAIL with fix hint when symlink is absent (ENOENT)", () => {
    const result = probeOpencodeTui({
      lstatSync: () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      readlinkSync: () => "",
      accessSync: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe("opencode TUI");
    expect(result.detail).toMatch(/not found|absent/i);
    expect(result.detail).toMatch(/install/i);
  });

  it("returns FAIL with fix hint when symlink exists but target is missing (dangling)", () => {
    const result = probeOpencodeTui({
      lstatSync: () => ({ isSymbolicLink: () => true }),
      readlinkSync: () => "/nonexistent/path/opencode",
      accessSync: () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe("opencode TUI");
    expect(result.detail).toMatch(/dangling|target.*missing|does not exist/i);
    expect(result.detail).toMatch(/install/i);
  });

  it("returns FAIL with fix hint when target exists but is not executable", () => {
    const result = probeOpencodeTui({
      lstatSync: () => ({ isSymbolicLink: () => true }),
      readlinkSync: () => "/home/user/.amico/opencode/canonical/current/opencode",
      accessSync: () => { const e: any = new Error("EACCES"); e.code = "EACCES"; throw e; },
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe("opencode TUI");
    expect(result.detail).toMatch(/not executable/i);
    expect(result.detail).toMatch(/install/i);
  });

  it("never throws even if fs functions throw unexpected errors", () => {
    const result = probeOpencodeTui({
      lstatSync: () => { throw new Error("disk I/O failure"); },
      readlinkSync: () => "",
      accessSync: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe("opencode TUI");
    expect(result.detail).toBeTruthy();
  });
});
