import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscodeMock from "vscode";

// Drive the live RunsManager (1.2, #57) over a temp runs root and assert the
// inspector calls. Ports the RunsRootWatcher state-machine coverage (idle-on-
// finished baseline, warming→completion, #66 pulse routing) onto index-driven
// discovery, and adds the multi-run behaviors: concurrent runs all tracked,
// selection routing, background completion/promote, the Scheduler seam, and
// the explicit-selection demo-replay path.
//
// The inspector is mocked (getInspector() returns spies); `vscode` is the
// aliased stub. tick() is called directly so the poll path is deterministic.

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

import { RunsManager, type SchedulerLifecycleEvent, type SchedulerLike } from "../src/runs_manager";

const channel = { appendLine() {}, append() {} } as never;
const META_LINE = 'AMICODE_PULSE_META drives=1 knots=2 labels="a_1" bounds=-0.2:0.2\n';

function writeManifest(dir: string, runId: string): void {
  writeFileSync(join(dir, "run.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\n` +
    `lab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`);
}
/** Stage a run dir + its index line (the amico-run writer's TSV format). */
function stageRun(root: string, runId: string, opts: { finished?: string; fidelity?: number; log?: string } = {}): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeManifest(dir, runId);
  if (opts.log !== undefined) writeFileSync(join(dir, "run.log"), opts.log);
  if (opts.fidelity !== undefined) writeFileSync(join(dir, "result.toml"), `schema_version = "1"\nfidelity = ${opts.fidelity}\niterations = 9\n`);
  if (opts.finished) writeFileSync(join(dir, "FINISHED"), `status = "${opts.finished}"\nexit_code = 0\n`);
  appendFileSync(join(root, "index"), `${runId}\t2026-07-03T00:00:00Z\t/s.jl\n`);
  return dir;
}
const tick = (m: RunsManager): void => (m as unknown as { tick(): void }).tick();

describe("RunsManager state machine (ported from RunsRootWatcher)", () => {
  beforeEach(() => { for (const f of Object.values(inspector)) f.mockClear(); });

  it("a run already FINISHED at launch stays idle — nothing re-rendered", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "r1", { finished: "completed", fidelity: 0.9999 });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    tick(m);
    expect(inspector.postPulse).not.toHaveBeenCalled();
    expect(inspector.postCompletion).not.toHaveBeenCalled();
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();
    expect(m.runs()).toHaveLength(1);                       // …but it IS registered
    expect(m.runs()[0]).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9999 });
    m.dispose();
  });

  it("fresh run → warming-up → completion (FINISHED-keyed, not result.toml presence)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = stageRun(root, "r2");                        // manifest only, no data yet
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(inspector.setWarmingUp).toHaveBeenCalledTimes(1);
    expect(inspector.setRunLabel).toHaveBeenCalledWith("r2");
    expect(m.selectedRun).toBe("r2");

    // result.toml alone must NOT complete the run (FINISHED is authoritative).
    writeFileSync(join(run, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 18\n');
    tick(m);
    expect(inspector.postCompletion).not.toHaveBeenCalled();

    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9999);
    m.dispose();
  });

  it("live tail forwards meta and each record in order as they land (#66)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = stageRun(root, "p1");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(inspector.postPulse).not.toHaveBeenCalled();

    writeFileSync(join(run, "run.log"), META_LINE + "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);
    expect(inspector.postPulse).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "meta" }));
    expect(inspector.postPulse).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 1 }) }));

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n");
    tick(m);
    expect(inspector.postPulse).toHaveBeenCalledTimes(3);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 2 }) }));
    m.dispose();
  });

  it("replay-seeded meta arms the live stream: tailed records flow without a re-sent meta", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    // Mid-flight discovery: meta + one record ALREADY on disk, run not finished.
    const run = stageRun(root, "p2", { log: META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n" });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();                                               // display replay → meta + newest record
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=4 dt=0.2 a=0.3,0.4\n");
    tick(m);                                                 // record parses against the armed meta
    expect(inspector.postPulse).toHaveBeenCalledTimes(3);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 4 }) }));
    m.dispose();
  });
});

describe("RunsManager multi-run (#57)", () => {
  beforeEach(() => { for (const f of Object.values(inspector)) f.mockClear(); });

  it("two concurrent live runs: newest auto-selected, BOTH tracked to completion", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.selectedRun).toBe("rA");

    const b = stageRun(root, "rB");                          // second solve starts
    tick(m);                                                 // index tail discovers it
    expect(m.selectedRun).toBe("rB");                        // auto-follow the newest start
    inspector.postIterationRecord.mockClear();

    // Background run A keeps streaming — tracked (registry) but NOT displayed.
    appendFileSync(join(a, "run.log"), "AMICODE_ITER iter=7 f=0.1 inf_pr=1e-8 inf_du=1e-6\n");
    tick(m);
    expect(inspector.postIterationRecord).not.toHaveBeenCalled();
    expect(m.runs().find(r => r.runId === "rA")?.latestIter).toBe(7);

    // A finishes in the background: registry terminal, inspector untouched…
    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9995\niterations = 7\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    tick(m);
    expect(inspector.postCompletion).not.toHaveBeenCalled(); // rB is selected
    expect(m.runs().find(r => r.runId === "rA")).toMatchObject({ phase: "finished", fidelity: 0.9995 });
    // …but the promote prompt STILL fires (fan-out is per-run, not per-selection).
    expect(promote).toHaveBeenCalledTimes(1);

    // B completes while selected → completion reaches the inspector.
    writeFileSync(join(b, "FINISHED"), 'status = "failed"\nexit_code = 3\n');
    tick(m);
    expect(inspector.postCompletion).toHaveBeenCalledWith("failed", undefined);
    promote.mockRestore();
    m.dispose();
  });

  it("selectRun back to a finished run replays its terminal state — promote never re-pops", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 3\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);                                                 // live completion (promotes once)
    stageRun(root, "rB");
    tick(m);                                                 // selection moves to rB
    expect(m.selectedRun).toBe("rB");

    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    inspector.postCompletion.mockClear();
    m.selectRun("rA");                                       // user switches back (1.3 seam)
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9999);
    expect(promote).not.toHaveBeenCalled();                  // promote-once held
    promote.mockRestore();
    m.dispose();
  });

  it("PULSE events are gated on selection too (not just iter) — background run's plot never reaches the inspector", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA", { log: META_LINE });        // rA armed with meta
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB");                           // rA now background
    inspector.postPulse.mockClear();

    // A background pulse RECORD on rA must not reach the inspector (rB selected).
    appendFileSync(join(a, "run.log"), "AMICODE_PULSE iter=5 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(inspector.postPulse).not.toHaveBeenCalled();
    m.dispose();
  });

  it("selecting a run whose FINISHED landed inside the poll window shows completion, never warming", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");                             // live at discovery → pipeline + selected
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);                                                    // selection moves to rB (rA still "live" in registry)
    inspector.setWarmingUp.mockClear();
    inspector.postCompletion.mockClear();

    // rA finishes on disk but the poll hasn't ticked (registry still says live).
    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 3\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    m.selectRun("rA");                                          // user switches back BEFORE the tick
    // selectRun re-checks disk → completion, NOT warming (no terminal-badge inversion).
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9999);
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();
    m.dispose();
  });

  it("an index line naming a missing run dir is tolerated (skipped, no throw)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    writeFileSync(join(root, "index"), "rGone\t2026-07-03T00:00:00Z\t/s.jl\n");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    tick(m);
    expect(m.runs()).toHaveLength(0);
    m.dispose();
  });

  it("scheduler `started` registers + selects the run immediately (the #56 seam)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();

    let emit!: (e: SchedulerLifecycleEvent) => void;
    const scheduler: SchedulerLike = { onEvent: (l) => { emit = l; return () => { /* dispose */ }; } };
    m.attachScheduler(scheduler);

    // A scheduler-launched run — no index line yet (the executor appends it,
    // but the started event beats the fs).
    const dir = join(root, "rSched");
    mkdirSync(dir); writeManifest(dir, "rSched");
    emit({ kind: "queued", queueId: "q1", position: 0 });     // logged, no throw
    emit({ kind: "started", queueId: "q1", runId: "rSched", runDir: dir });
    expect(m.selectedRun).toBe("rSched");
    expect(inspector.setRunLabel).toHaveBeenCalledWith("rSched");
    expect(inspector.setWarmingUp).toHaveBeenCalled();

    // The index line landing later is a no-op (registration is idempotent).
    appendFileSync(join(root, "index"), "rSched\t2026-07-03T00:00:00Z\t/s.jl\n");
    tick(m);
    expect(m.runs().filter(r => r.runId === "rSched")).toHaveLength(1);
    m.dispose();
  });

  it("demo replay: a finished run registers quietly; EXPLICIT selection renders it, promote suppressed", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rDemo", {
      finished: "completed", fidelity: 0.9998,
      log: META_LINE + "AMICODE_PULSE iter=60 dt=0.2 a=0.1,0.2\nAMICODE_ITER iter=60 f=2e-3 inf_pr=1e-9 inf_du=1e-6\n",
    });
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    m.pokeDiscovery();                                        // same-tick registration…
    expect(inspector.postCompletion).not.toHaveBeenCalled();  // …but no auto-display
    m.selectRun("rDemo");                                     // the replayDemo command's path
    expect(inspector.setRunLabel).toHaveBeenCalledWith("rDemo");
    expect(inspector.postPulse).toHaveBeenCalledWith(expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 60 }) }));
    expect(inspector.postCompletion).toHaveBeenCalledWith("completed", 0.9998);
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();    // finished — never "warming"
    expect(promote).not.toHaveBeenCalled();                   // finished-at-discovery: no prompt
    promote.mockRestore();
    m.dispose();
  });
});
