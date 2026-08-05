import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCloudRun, runLocationLabel } from "../src/run_location";

// A cloud run and a local run used to produce an IDENTICAL Inspector pane, so a
// user paying for Piccolissimo + Altissimo had no way to see from the UI that the
// solve went to the cloud. The run dir answers it: remote.json is written by
// RemoteExecutor and by nothing else.

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

describe("runLocationLabel", () => {
  it("names the cloud on a remote run", () => {
    const d = runDir({ "remote.json": "{}" });
    expect(runLocationLabel("r20260804-1", d)).toBe("r20260804-1 · Harmoniqs Cloud");
  });

  it("leaves a local run's label as the bare runId", () => {
    // The label has to stay unchanged for local runs: it earns the space only
    // when it distinguishes something, and every existing pane is local.
    expect(runLocationLabel("r20260804-1", runDir({}))).toBe("r20260804-1");
  });

  it("no run dir known yet → bare runId, no throw", () => {
    expect(runLocationLabel("r1", undefined)).toBe("r1");
  });
});
