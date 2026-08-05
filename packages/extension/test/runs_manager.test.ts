import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscodeMock from "vscode";

// Drive the live RunsManager (1.2 #57 / 1.3 #58) over a temp runs root and
// assert the inspector calls. Ports the RunsRootWatcher state-machine coverage
// (idle-on-finished baseline, warming→completion, #66 pulse routing) onto
// index-driven discovery, and adds the multi-run behaviors: concurrent runs all
// tracked, selection routing, background completion/promote, the Scheduler seam,
// and the explicit-selection demo-replay path.
//
// 1.3: the inspector protocol is runId-keyed and the manager FANS every run's
// events into it runId-tagged (the webview shows only the active pane). The
// single status bar stays selection-gated — so background-vs-foreground is now
// asserted on the status bar, not on whether the inspector was called.
//
// The inspector is mocked (getInspector() returns spies); `vscode` is the
// aliased stub. tick() is called directly so the poll path is deterministic.

const { inspector } = vi.hoisted(() => ({
  inspector: {
    setWarmingUp: vi.fn(),
    postTiming: vi.fn(),
    postCompletion: vi.fn(),
    postIterationRecord: vi.fn(),
    postPulse: vi.fn(),
    setRunLabel: vi.fn(),
    setCloudRun: vi.fn(),
    activate: vi.fn(),
    reveal: vi.fn(),
  },
}));
vi.mock("../src/run_inspector", () => ({ getInspector: () => inspector }));

import { RunsManager, type SchedulerLifecycleEvent, type SchedulerLike } from "../src/runs_manager";

const channel = { appendLine() {}, append() {} } as never;
const META_LINE = 'AMICODE_PULSE_META drives=1 knots=2 labels="a_1" bounds=-0.2:0.2\n';

/** Minimal StatusBarManager spy — only setRun is exercised. */
function statusBarSpy() {
  return { setRun: vi.fn(), clear: vi.fn(), dispose: vi.fn() };
}

function writeManifest(dir: string, runId: string): void {
  writeFileSync(
    join(dir, "run.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\n` +
      `lab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`,
  );
}
/** Stage a run dir + its index line (the amico-run writer's TSV format). */
function stageRun(
  root: string,
  runId: string,
  opts: { finished?: string; fidelity?: number; log?: string } = {},
): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeManifest(dir, runId);
  if (opts.log !== undefined) writeFileSync(join(dir, "run.log"), opts.log);
  if (opts.fidelity !== undefined)
    writeFileSync(join(dir, "result.toml"), `schema_version = "1"\nfidelity = ${opts.fidelity}\niterations = 9\n`);
  if (opts.finished) writeFileSync(join(dir, "FINISHED"), `status = "${opts.finished}"\nexit_code = 0\n`);
  appendFileSync(join(root, "index"), `${runId}\t2026-07-03T00:00:00Z\t/s.jl\n`);
  return dir;
}
const tick = (m: RunsManager): void => (m as unknown as { tick(): void }).tick();

describe("RunsManager state machine (ported from RunsRootWatcher)", () => {
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  it("a run already FINISHED at launch stays idle — nothing re-rendered", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "r1", { finished: "completed", fidelity: 0.9999 });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    tick(m);
    expect(inspector.postPulse).not.toHaveBeenCalled();
    expect(inspector.postCompletion).not.toHaveBeenCalled();
    expect(inspector.setWarmingUp).not.toHaveBeenCalled();
    expect(m.runs()).toHaveLength(1); // …but it IS registered
    expect(m.runs()[0]).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9999 });
    m.dispose();
  });

  it("fresh run → warming-up → completion (FINISHED-keyed, not result.toml presence)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    // Registered AFTER boot (a run that STARTS while the user works) — the
    // boot-replay path is warming-quiet by design (see the boot test below).
    const run = stageRun(root, "r2"); // manifest only, no data yet
    tick(m);
    expect(inspector.setWarmingUp).toHaveBeenCalledWith("r2");
    expect(inspector.setRunLabel).toHaveBeenCalledWith("r2", "r2");
    expect(inspector.activate).toHaveBeenCalledWith("r2"); // 1.3: selection = activate the pane
    expect(m.selectedRun).toBe("r2");

    // result.toml alone must NOT complete the run (FINISHED is authoritative).
    writeFileSync(join(run, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 18\n');
    tick(m);
    expect(inspector.postCompletion).not.toHaveBeenCalled();

    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);
    expect(inspector.postCompletion).toHaveBeenCalledWith("r2", "completed", 0.9999);
    m.dispose();
  });

  it("BOOT replay is warming/reveal-quiet: a live run discovered at start() is tracked but never steals focus", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rBoot"); // live run exists BEFORE start
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.selectedRun).toBe("rBoot"); // state still selects it…
    expect(inspector.setWarmingUp).not.toHaveBeenCalled(); // …but no warming focus
    expect(inspector.reveal).not.toHaveBeenCalled(); // …and no reveal at boot
    m.dispose();
  });

  it("live tail forwards meta and each record in order as they land (#66), runId-tagged", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = stageRun(root, "p1");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(inspector.postPulse).not.toHaveBeenCalled();

    writeFileSync(join(run, "run.log"), META_LINE + "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);
    expect(inspector.postPulse).toHaveBeenNthCalledWith(1, "p1", expect.objectContaining({ type: "meta" }));
    expect(inspector.postPulse).toHaveBeenNthCalledWith(
      2,
      "p1",
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 1 }) }),
    );

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n");
    tick(m);
    expect(inspector.postPulse).toHaveBeenCalledTimes(3);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(
      "p1",
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 2 }) }),
    );
    m.dispose();
  });

  it("replay-seeded meta arms the live stream: tailed records flow without a re-sent meta", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    // Mid-flight discovery: meta + one record ALREADY on disk, run not finished.
    const run = stageRun(root, "p2", { log: META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n" });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start(); // display replay → meta + newest record
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=4 dt=0.2 a=0.3,0.4\n");
    tick(m); // record parses against the armed meta
    expect(inspector.postPulse).toHaveBeenCalledTimes(3);
    expect(inspector.postPulse).toHaveBeenLastCalledWith(
      "p2",
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 4 }) }),
    );
    m.dispose();
  });
});

describe("RunsManager multi-run (#57 / #58 fan-out)", () => {
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  it("two concurrent live runs: newest auto-selected; both fanned to the inspector, status bar tracks the selected only", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");
    const statusBar = statusBarSpy();
    const m = new RunsManager({ runsRoot: root, channel, statusBar: statusBar as never });
    m.start();
    expect(m.selectedRun).toBe("rA");

    const b = stageRun(root, "rB"); // second solve starts
    tick(m); // index tail discovers it
    expect(m.selectedRun).toBe("rB"); // auto-follow the newest start
    inspector.postIterationRecord.mockClear();
    statusBar.setRun.mockClear();

    // Background run A keeps streaming — FANNED to the inspector runId-tagged (the
    // webview keeps it in rA's hidden pane) but the single status bar is untouched.
    appendFileSync(join(a, "run.log"), "AMICODE_ITER iter=7 f=0.1 inf_pr=1e-8 inf_du=1e-6\n");
    tick(m);
    expect(inspector.postIterationRecord).toHaveBeenCalledWith("rA", expect.objectContaining({ iter: 7 }));
    expect(statusBar.setRun).not.toHaveBeenCalled(); // selection-gated: rB is selected
    expect(m.runs().find((r) => r.runId === "rA")?.latestIter).toBe(7);

    // A finishes in the background: registry terminal, completion fanned to the
    // inspector (rA's pane badge), status bar still untouched…
    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9995\niterations = 7\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    tick(m);
    expect(inspector.postCompletion).toHaveBeenCalledWith("rA", "completed", 0.9995);
    expect(statusBar.setRun).not.toHaveBeenCalled(); // still rB selected
    expect(m.runs().find((r) => r.runId === "rA")).toMatchObject({ phase: "finished", fidelity: 0.9995 });
    // …and the promote prompt STILL fires (fan-out is per-run, not per-selection).
    expect(promote).toHaveBeenCalledTimes(1);

    // B completes while selected → completion + status bar both fire.
    writeFileSync(join(b, "FINISHED"), 'status = "failed"\nexit_code = 3\n');
    tick(m);
    expect(inspector.postCompletion).toHaveBeenCalledWith("rB", "failed", undefined);
    expect(statusBar.setRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "rB", status: "failed" }));
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
    tick(m); // live completion (promotes once)
    stageRun(root, "rB");
    tick(m); // selection moves to rB
    expect(m.selectedRun).toBe("rB");

    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    inspector.postCompletion.mockClear();
    m.selectRun("rA"); // user switches back (1.3 seam)
    expect(inspector.activate).toHaveBeenCalledWith("rA");
    expect(inspector.postCompletion).toHaveBeenCalledWith("rA", "completed", 0.9999);
    expect(promote).not.toHaveBeenCalled(); // promote-once held
    promote.mockRestore();
    m.dispose();
  });

  it("PULSE events are fanned to the inspector runId-tagged even for a background run (webview shows only the active pane)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA", { log: META_LINE }); // rA armed with meta
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB"); // rA now background
    inspector.postPulse.mockClear();

    // A background pulse RECORD on rA reaches the inspector TAGGED "rA" — the
    // webview routes it to rA's hidden pane, never the visible rB plot.
    appendFileSync(join(a, "run.log"), "AMICODE_PULSE iter=5 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(inspector.postPulse).toHaveBeenCalledWith(
      "rA",
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 5 }) }),
    );
    m.dispose();
  });

  it("selecting a run whose FINISHED landed inside the poll window shows completion, never warming", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA"); // live at discovery → pipeline + selected
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m); // selection moves to rB (rA still "live" in registry)
    inspector.setWarmingUp.mockClear();
    inspector.postCompletion.mockClear();

    // rA finishes on disk but the poll hasn't ticked (registry still says live).
    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 3\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    m.selectRun("rA"); // user switches back BEFORE the tick
    // selectRun re-checks disk → completion, NOT warming (no terminal-badge inversion).
    expect(inspector.postCompletion).toHaveBeenCalledWith("rA", "completed", 0.9999);
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
    const scheduler: SchedulerLike = {
      onEvent: (l) => {
        emit = l;
        return () => {
          /* dispose */
        };
      },
    };
    m.attachScheduler(scheduler);

    // A scheduler-launched run — no index line yet (the executor appends it,
    // but the started event beats the fs).
    const dir = join(root, "rSched");
    mkdirSync(dir);
    writeManifest(dir, "rSched");
    emit({ kind: "queued", queueId: "q1", position: 0 }); // logged, no throw
    emit({ kind: "started", queueId: "q1", runId: "rSched", runDir: dir });
    expect(m.selectedRun).toBe("rSched");
    expect(inspector.setRunLabel).toHaveBeenCalledWith("rSched", "rSched");
    expect(inspector.activate).toHaveBeenCalledWith("rSched");
    expect(inspector.setWarmingUp).toHaveBeenCalledWith("rSched");

    // The index line landing later is a no-op (registration is idempotent).
    appendFileSync(join(root, "index"), "rSched\t2026-07-03T00:00:00Z\t/s.jl\n");
    tick(m);
    expect(m.runs().filter((r) => r.runId === "rSched")).toHaveLength(1);
    m.dispose();
  });

  it("demo replay: a finished run registers quietly; EXPLICIT selection renders it, promote suppressed", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rDemo", {
      finished: "completed",
      fidelity: 0.9998,
      log: META_LINE + "AMICODE_PULSE iter=60 dt=0.2 a=0.1,0.2\nAMICODE_ITER iter=60 f=2e-3 inf_pr=1e-9 inf_du=1e-6\n",
    });
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    m.pokeDiscovery(); // same-tick registration…
    expect(inspector.postCompletion).not.toHaveBeenCalled(); // …but no auto-display
    m.selectRun("rDemo"); // the replayDemo command's path
    expect(inspector.setRunLabel).toHaveBeenCalledWith("rDemo", "rDemo");
    expect(inspector.activate).toHaveBeenCalledWith("rDemo");
    expect(inspector.postPulse).toHaveBeenCalledWith(
      "rDemo",
      expect.objectContaining({ type: "record", record: expect.objectContaining({ iter: 60 }) }),
    );
    expect(inspector.postCompletion).toHaveBeenCalledWith("rDemo", "completed", 0.9998);
    expect(inspector.setWarmingUp).not.toHaveBeenCalled(); // finished — never "warming"
    expect(promote).not.toHaveBeenCalled(); // finished-at-discovery: no prompt
    promote.mockRestore();
    m.dispose();
  });
});

// Review #70 findings — one test per fix (jack-champagne's static/design pass).
describe("RunsManager review-#70 fixes", () => {
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  it("#1 explicit selection is PINNED — a new live run registering does not steal the view", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rA", { finished: "completed", fidelity: 0.9 });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    m.selectRun("rA"); // the user deliberately opens rA
    expect(m.selectedRun).toBe("rA");
    inspector.setRunLabel.mockClear();

    stageRun(root, "rB"); // background solve starts
    tick(m);
    expect(m.selectedRun).toBe("rA"); // auto-follow deferred to the pin
    expect(inspector.setRunLabel).not.toHaveBeenCalledWith("rB", "rB");
    expect(inspector.activate).not.toHaveBeenCalledWith("rB"); // visible pane untouched
    expect(m.runs().find((r) => r.runId === "rB")?.phase).toBe("live"); // …but rB IS tracked

    m.selectRun("rB"); // explicit switch still works
    expect(m.selectedRun).toBe("rB");
    m.dispose();
  });

  it("#1 auto-follow still applies while nothing was explicitly selected (β latest-follow parity)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB"); // no pin → newest live run wins
    m.dispose();
  });

  it("#2 a torn/invalid FINISHED at discovery is retried, not finalized as status:undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const dir = join(root, "rTorn");
    mkdirSync(dir, { recursive: true });
    writeManifest(dir, "rTorn");
    writeFileSync(join(dir, "result.toml"), 'schema_version = "1"\nfidelity = 0.9997\niterations = 5\n');
    writeFileSync(join(dir, "FINISHED"), 'status = "comp'); // torn mid-write: invalid TOML
    appendFileSync(join(root, "index"), "rTorn\t2026-07-04T00:00:00Z\t/s.jl\n");

    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    // NOT finalized with an undefined status — held live so the retry lane owns it.
    expect(m.runs().find((r) => r.runId === "rTorn")).toMatchObject({ phase: "live" });
    expect(inspector.setWarmingUp).not.toHaveBeenCalled(); // FINISHED exists on disk — never "warming"

    writeFileSync(join(dir, "FINISHED"), 'status = "completed"\nexit_code = 0\n'); // the write completes
    tick(m);
    expect(m.runs().find((r) => r.runId === "rTorn")).toMatchObject({
      phase: "finished",
      status: "completed",
      fidelity: 0.9997,
    });
    expect(promote).not.toHaveBeenCalled(); // still a launch replay — promote suppressed
    promote.mockRestore();
    m.dispose();
  });

  it("#4 discovery ingests the run dir ONCE — no second display pass (registration replay feeds the display)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rOne", { log: META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n" });
    // The old shape ran ingestRunDir twice per discovery: a pipelineSink state
    // pass, then auto-follow's selectRun → a displaySink DISPLAY pass over the
    // same run.log. displaySink now only backs EXPLICIT selection replays — its
    // absence during discovery is the single-pass property.
    const displayPass = vi.spyOn(RunsManager.prototype as never as { displaySink(): unknown }, "displaySink");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(displayPass).not.toHaveBeenCalled(); // was 1 per discovery
    // …and the single pass still displayed the history (meta + newest record):
    expect(inspector.postPulse).toHaveBeenCalledTimes(2);
    displayPass.mockRestore();
    m.dispose();
  });
});

describe("mid-session stall surfaces on the status bar", () => {
  it("tick downgrades the selected run to 'stalled' once run.log goes cold (and never upgrades)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const statusBar = statusBarSpy();
    const m = new RunsManager({ runsRoot: root, channel, statusBar: statusBar as never });
    m.start();
    const dir = stageRun(root, "r-wedge", { log: "AMICODE_ITER iter=8 f=1.07e+01 inf_pr=1e-3 inf_du=1e-2\n" });
    tick(m); // registers + replays → status bar sees running/iter 8 via routeIter
    statusBar.setRun.mockClear();

    // age run.log past the stall threshold, then let the poll backstop fire
    const cold = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(join(dir, "run.log"), cold, cold);
    (m as unknown as { liveStatusCache: Map<string, unknown> }).liveStatusCache.clear();
    tick(m);
    const stalledCall = statusBar.setRun.mock.calls.find((c) => c[0]?.status === "stalled");
    expect(stalledCall?.[0]).toMatchObject({ runId: "r-wedge", status: "stalled", latestIter: 8 });

    // a finished run must NOT be re-stamped by the backstop
    writeFileSync(join(dir, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);
    statusBar.setRun.mockClear();
    (m as unknown as { liveStatusCache: Map<string, unknown> }).liveStatusCache.clear();
    tick(m);
    expect(statusBar.setRun.mock.calls.every((c) => c[0]?.status !== "stalled")).toBe(true);
    m.dispose();
  });
});
