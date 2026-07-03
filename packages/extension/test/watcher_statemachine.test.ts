import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
    setWarmingUp: vi.fn(),
    postCompletion: vi.fn(),
    postIterationRecord: vi.fn(),
    postPulse: vi.fn(),
    setRunLabel: vi.fn(),
    reveal: vi.fn(),
  },
}));
vi.mock("../src/run_inspector", () => ({ getInspector: () => inspector }));

import { RunsRootWatcher } from "../src/file_watcher";

const channel = { appendLine() {}, append() {} } as never;

function writeManifest(dir: string, runId: string): void {
  writeFileSync(join(dir, "run.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\n` +
    `lab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`);
}
function setLatest(root: string, target: string): void {
  const link = join(root, "latest");
  try { rmSync(link); } catch { /* none */ }
  symlinkSync(target, link);
}
const tick = (w: RunsRootWatcher): void => (w as unknown as { tick(): void }).tick();
const META_LINE = 'AMICODE_PULSE_META drives=1 knots=2 labels="u_1" bounds=-0.2:0.2\n';

describe("RunsRootWatcher state machine", () => {
  beforeEach(() => { for (const f of Object.values(inspector)) f.mockClear(); });

  it("a run already FINISHED at launch stays idle — nothing re-rendered", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "r1"); mkdirSync(run);
    writeManifest(run, "r1");
    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    setLatest(root, run);

    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();
    tick(w);   // even after a poll, a finished-at-launch run must render nothing
    expect(inspector.postPulse).not.toHaveBeenCalled();
    expect(inspector.postCompletion).not.toHaveBeenCalled();
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();
    w.dispose();
  });

  it("fresh run → warming-up → completion (plot arrives via pulse routing, not frames)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "r2"); mkdirSync(run);
    writeManifest(run, "r2");                                      // manifest only, no data yet
    setLatest(root, run);

    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();
    // fresh run with no data → warming, not idle
    expect(inspector.setWarmingUp).toHaveBeenCalledTimes(1);
    expect(inspector.setRunLabel).toHaveBeenCalledWith("r2");

    // FINISHED + result → terminal completion delivered once
    writeFileSync(join(run, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 18\n');
    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(w);
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9999);
    w.dispose();
  });
});

// #66 AC6 — live-tail pulse routing. On a live run the tailer is the ONLY
// carrier of meta (ingest sees an empty log at run start), so the tail path
// must forward meta AND each record, in order.
describe("pulse-line routing (#66)", () => {
  beforeEach(() => { for (const f of Object.values(inspector)) f.mockClear(); });

  it("live tail forwards meta and each record in order as they land", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "p1"); mkdirSync(run);
    writeManifest(run, "p1");
    setLatest(root, run);
    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();                                        // fresh run, empty log → warming
    expect(inspector.postPulse).not.toHaveBeenCalled();

    writeFileSync(join(run, "run.log"), META_LINE + "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n");
    tick(w);                                          // poll poke drains the tailer
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);
    expect(inspector.postPulse).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "meta" }));
    expect(inspector.postPulse).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 1 }) }));

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n");
    tick(w);
    expect(inspector.postPulse).toHaveBeenCalledTimes(3);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 2 }) }));
    w.dispose();
  });

  it("replay-seeded meta arms the live stream: tailed records flow without a re-sent meta", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = join(root, "p2"); mkdirSync(run);
    writeManifest(run, "p2");
    // Mid-flight switch: meta + one record ALREADY on disk, run not finished.
    writeFileSync(join(run, "run.log"), META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n");
    setLatest(root, run);
    const w = new RunsRootWatcher({ runsRoot: root, channel });
    w.start();                                        // ingest replays meta + newest record
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);

    // a record tailed AFTER attach, with no meta line in the tailed region
    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=4 dt=0.2 a=0.5,0.6\n");
    tick(w);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 4 }) }));
    w.dispose();
  });
});
