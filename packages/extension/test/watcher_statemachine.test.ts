import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the live RunsRootWatcher state machine over a temp run dir and assert the
// inspector calls — the poll backstop + idle-on-finished baseline + warming→frame
// transition that the SinkDedup unit test does NOT cover (Jack's #23 [important]).
//
// The inspector is mocked (so getInspector() returns spies); `vscode` is the
// aliased stub (vitest.config.ts). We call the private tick() directly so the
// poll path is exercised deterministically instead of racing the 700ms timer.

const { inspector } = vi.hoisted(() => ({
  inspector: {
    setImageSource: vi.fn(),
    setWarmingUp: vi.fn(),
    postCompletion: vi.fn(),
    postIterationRecord: vi.fn(),
    setRunLabel: vi.fn(),
    reveal: vi.fn(),
  },
}));
vi.mock("../src/run_inspector", () => ({ getInspector: () => inspector }));

import { RunsRootWatcher } from "../src/file_watcher";

const channel = { appendLine() {}, append() {} } as never;

function writeManifest(dir: string, runId: string): void {
  writeFileSync(join(dir, "manifest.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\n` +
    `lab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`);
}
function setLatest(root: string, target: string): void {
  const link = join(root, "latest");
  try { rmSync(link); } catch { /* none */ }
  symlinkSync(target, link);
}
const tick = (w: RunsRootWatcher): void => (w as unknown as { tick(): void }).tick();

describe("RunsRootWatcher state machine", () => {
  beforeEach(() => { for (const f of Object.values(inspector)) f.mockClear(); });

  it("a run already FINISHED at launch stays idle — no stale plot re-rendered", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "r1"); mkdirSync(run);
    writeManifest(run, "r1");
    writeFileSync(join(run, "iter_6.png"), "PNG");                 // a frame is on disk…
    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    setLatest(root, run);

    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();
    tick(w);   // even after a poll, a finished-at-launch run must render nothing
    expect(inspector.setImageSource).not.toHaveBeenCalled();       // …but it's NOT shown
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();
    w.dispose();
  });

  it("fresh run → warming-up → poll delivers newest frame (newest-wins) → completion", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "r2"); mkdirSync(run);
    writeManifest(run, "r2");                                      // manifest only, no frames yet
    setLatest(root, run);

    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();
    // fresh run with no frames → warming, not idle, not a frame
    expect(inspector.setWarmingUp).toHaveBeenCalledTimes(1);
    expect(inspector.setRunLabel).toHaveBeenCalledWith("r2");
    expect(inspector.setImageSource).not.toHaveBeenCalled();

    // first frame appears; the poll backstop delivers it (no reliance on fs.watch)
    writeFileSync(join(run, "iter_6.png"), "PNG");
    tick(w);
    expect(inspector.setImageSource).toHaveBeenLastCalledWith(expect.stringContaining("iter_6.png"), 6);

    // two frames land between ticks → only the NEWEST is delivered
    writeFileSync(join(run, "iter_12.png"), "PNG");
    writeFileSync(join(run, "iter_18.png"), "PNG");
    tick(w);
    expect(inspector.setImageSource).toHaveBeenLastCalledWith(expect.stringContaining("iter_18.png"), 18);

    // FINISHED + result → terminal completion delivered once
    writeFileSync(join(run, "result.toml"), "fidelity = 0.9999\niterations = 18\n");
    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(w);
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9999);
    w.dispose();
  });
});
