import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateSessionId,
  buildLaunchRecord,
  writeFleetRecord,
  launchFromProfile,
  computeFleetStats,
  readAllSimpleRecords,
  sweepCrashed,
  isProcessAlive,
} from "../src/fleet_launch";
import type { FleetProfile } from "../src/fleet_profiles";

const SAMPLE_PROFILE: FleetProfile = {
  schema: 1,
  name: "researcher-opus",
  base: "pulse-designer",
  model: "anthropic.claude-opus-4-6-v1",
  variant: "",
  task_type: "interactive",
  skills: ["transmon", "atoms"],
  gates: [],
  permissions: { bash: "allow", file_write: "allow" },
};

describe("generateSessionId", () => {
  it("produces ses_ prefix + 12 hex chars", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^ses_[0-9a-f]{12}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe("buildLaunchRecord", () => {
  it("creates a record in spooling state from a profile", () => {
    const record = buildLaunchRecord(SAMPLE_PROFILE);
    expect(record.state).toBe("spooling");
    expect(record.session_id).toMatch(/^ses_/);
    expect(record.tokens).toBe(0);
    expect(record.runtime).toBe(0);
    expect(record.profile.name).toBe("researcher-opus");
    expect(record.profile.model).toBe("anthropic.claude-opus-4-6-v1");
    expect(record.profile.skills).toEqual(["transmon", "atoms"]);
    expect(record.pid).toBe(process.pid);
    expect(record.started).toBeTruthy();
  });
});

describe("writeFleetRecord + launchFromProfile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-launch-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a TOML file with the session_id as filename", () => {
    const record = buildLaunchRecord(SAMPLE_PROFILE);
    const p = writeFleetRecord(record, tmp);
    expect(fs.existsSync(p)).toBe(true);
    expect(path.basename(p)).toBe(`${record.session_id}.toml`);
    const content = fs.readFileSync(p, "utf8");
    expect(content).toContain("spooling");
    expect(content).toContain("researcher-opus");
  });

  it("launchFromProfile returns sessionId and recordPath", () => {
    const result = launchFromProfile(SAMPLE_PROFILE, tmp);
    expect(result.sessionId).toMatch(/^ses_/);
    expect(fs.existsSync(result.recordPath)).toBe(true);
  });
});

describe("computeFleetStats", () => {
  it("counts active (running + blocked + spooling)", () => {
    const records = [
      { state: "running", tokens: 100, started: "2026-08-13T10:00:00Z" },
      { state: "running", tokens: 200, started: "2026-08-13T11:00:00Z" },
      { state: "blocked", tokens: 50, started: "2026-08-13T09:00:00Z" },
      { state: "spooling", tokens: 0, started: "2026-08-13T12:00:00Z" },
      { state: "settled", tokens: 500, started: "2026-08-13T08:00:00Z" },
      { state: "crashed", tokens: 30, started: "2026-08-12T10:00:00Z" },
    ];
    const stats = computeFleetStats(records, { today: "2026-08-13" });
    expect(stats.active).toBe(4); // running + blocked + spooling
    expect(stats.running).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.tokensToday).toBe(850); // 100 + 200 + 50 + 0 + 500 (all started today)
  });

  it("returns zeros for empty records", () => {
    const stats = computeFleetStats([]);
    expect(stats.active).toBe(0);
    expect(stats.running).toBe(0);
    expect(stats.blocked).toBe(0);
    expect(stats.tokensToday).toBe(0);
  });
});

describe("readAllSimpleRecords", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-stats-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads state + tokens from TOML files", () => {
    fs.writeFileSync(path.join(tmp, "ses_abc.toml"), `state = "running"\ntokens = 42\nstarted = "2026-08-13T10:00:00Z"\n`);
    fs.writeFileSync(path.join(tmp, "ses_def.toml"), `state = "settled"\ntokens = 100\nstarted = "2026-08-13T11:00:00Z"\n`);
    const records = readAllSimpleRecords(tmp);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.state === "running")?.tokens).toBe(42);
  });

  it("skips dot-files", () => {
    fs.writeFileSync(path.join(tmp, ".tmp.toml"), `state = "running"\ntokens = 1\n`);
    expect(readAllSimpleRecords(tmp)).toHaveLength(0);
  });

  it("returns empty for missing directory", () => {
    expect(readAllSimpleRecords("/nonexistent/path")).toEqual([]);
  });
});

describe("sweepCrashed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-sweep-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("marks running sessions with dead pids as crashed", () => {
    // Use a pid that definitely doesn't exist
    const deadPid = 99999999;
    fs.writeFileSync(
      path.join(tmp, "ses_dead.toml"),
      `state = "running"\npid = ${deadPid}\ntokens = 10\nstarted = "2026-08-13"\n`,
    );
    const swept = sweepCrashed(tmp);
    expect(swept).toContain("ses_dead");
    const content = fs.readFileSync(path.join(tmp, "ses_dead.toml"), "utf8");
    expect(content).toContain('state = "crashed"');
  });

  it("does not touch settled sessions", () => {
    fs.writeFileSync(
      path.join(tmp, "ses_ok.toml"),
      `state = "settled"\npid = 99999999\ntokens = 10\nstarted = "2026-08-13"\n`,
    );
    const swept = sweepCrashed(tmp);
    expect(swept).toHaveLength(0);
  });

  it("does not touch sessions with alive pids", () => {
    // Current process is alive
    fs.writeFileSync(
      path.join(tmp, "ses_alive.toml"),
      `state = "running"\npid = ${process.pid}\ntokens = 10\nstarted = "2026-08-13"\n`,
    );
    const swept = sweepCrashed(tmp);
    expect(swept).toHaveLength(0);
  });
});

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for pid 0 or negative", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
