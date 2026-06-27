import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateRunId, appendIndex, updateLatest } from "@amicode/amico-run";

/**
 * Copy a bundled demo run-dir into the runs root under a fresh β.1 runId,
 * rewrite run.toml's `run_id` to match the new directory, append the
 * index, and swing `latest` to it. Reuses the β.1 run-dir primitives so the
 * staged run is byte-for-byte contract-identical and the existing
 * RunsRootWatcher renders it exactly like a live solve.
 *
 * Filesystem side effects only (pure w.r.t. its inputs). Returns the staged
 * run directory.
 */
export function stageDemoRun(demoDir: string, runsRoot: string): string {
  mkdirSync(runsRoot, { recursive: true });
  const runId = generateRunId(runsRoot);
  const runDir = join(runsRoot, runId);
  mkdirSync(runDir);
  for (const f of readdirSync(demoDir)) {
    if (f === "run.toml") {
      const m = readFileSync(join(demoDir, f), "utf8").replace(
        /run_id\s*=\s*"[^"]*"/,
        `run_id = ${JSON.stringify(runId)}`,
      );
      writeFileSync(join(runDir, f), m);
    } else {
      copyFileSync(join(demoDir, f), join(runDir, f));
    }
  }
  appendIndex(runsRoot, runId, new Date().toISOString(), "demo-replay");
  updateLatest(runsRoot, runId);
  return runDir;
}
