import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCloudRun } from "../src/run_location";

// A cloud run and a local run used to produce an IDENTICAL Inspector pane, so a
// user paying for Piccolissimo + Altissimo had no way to see from the UI that the
// solve went to the cloud. The run dir answers it: remote.json is written by
// RemoteExecutor and by nothing else. What the UI does with the answer lives in
// cloud_badge.test.ts (topbar badge) and status_bar.test.ts (status bar).

function runDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "rundir-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

describe("isCloudRun", () => {
  it("a remote run dir carries remote.json", () => {
    const d = runDir({ "remote.json": JSON.stringify({ task_id: "t-1", base_url: "https://api" }) });
    expect(isCloudRun(d)).toBe(true);
  });

  it("a local run dir does not", () => {
    expect(isCloudRun(runDir({ "run.toml": 'run_id = "r1"\n' }))).toBe(false);
  });

  it("a missing dir is not a cloud run, and never throws", () => {
    expect(isCloudRun(join(tmpdir(), "definitely-absent-", String(Math.random())))).toBe(false);
  });
});
