import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscodeMock from "vscode";

// #351: RunsManager now posts to the Work Column bridge (inspector_bridge) instead
// of the deleted bottom-panel WebviewViewProvider. Mock the bridge functions.

const bridge = vi.hoisted(() => ({
  postRunIteration: vi.fn(),
  postRunPulseMeta: vi.fn(),
  postRunPulse: vi.fn(),
  postRunCompletion: vi.fn(),
  postRunActivate: vi.fn(),
  postRunLabel: vi.fn(),
  postRunTiming: vi.fn(),
  postDeviceStatus: vi.fn(),
  postDeviceActions: vi.fn(),
  postDeviceActivate: vi.fn(),
}));
vi.mock("../src/inspector_bridge", () => bridge);

import { RunsManager, type SchedulerLifecycleEvent, type SchedulerLike } from "../src/runs_manager";

const channel = { appendLine() {}, append() {} } as never;
const META_LINE = 'AMICODE_PULSE_META drives=1 knots=2 labels="a_1" bounds=-0.2:0.2\n';

function writeManifest(dir: string, runId: string): void {
  writeFileSync(
    join(dir, "run.toml"),
    `schema_version = "1"\nrun_id = "${runId}"\nscript_path = "/s.jl"\nlab = "default"\n` +
      `lab_id = "default"\ncreated_at = "2026-06-15T00:00:00Z"\norchestrator_version = "0.1.0"\n[julia]\nbinary = "julia"\n`,
  );
}
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
    for (const f of Object.values(bridge)) f.mockClear();
  });

  it("a run already FINISHED at launch stays idle — nothing re-rendered", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "r1", { finished: "completed", fidelity: 0.9999 });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    tick(m);
    expect(bridge.postRunPulse).not.toHaveBeenCalled();
    expect(bridge.postRunCompletion).not.toHaveBeenCalled();
    expect(m.runs()).toHaveLength(1);
    expect(m.runs()[0]).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9999 });
    m.dispose();
  });

  it("fresh run → activation → completion (FINISHED-keyed, not result.toml presence)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    const run = stageRun(root, "r2");
    tick(m);
    expect(bridge.postRunLabel).toHaveBeenCalledWith("r2", "r2");
    expect(bridge.postRunActivate).toHaveBeenCalledWith("r2");
    expect(m.selectedRun).toBe("r2");

    writeFileSync(join(run, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 18\n');
    tick(m);
    expect(bridge.postRunCompletion).not.toHaveBeenCalled();

    writeFileSync(join(run, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("r2", 0.9999, expect.any(Number), "completed");
    m.dispose();
  });

  it("BOOT replay is quiet: a live run discovered at start() is tracked", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rBoot");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.selectedRun).toBe("rBoot");
    m.dispose();
  });

  it("getActiveRunPointer is the selected run's runId (relative pointer, never an absolute path)", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.getActiveRunPointer()).toBeUndefined();
    stageRun(root, "default/20260803-104655-x-gate");
    tick(m);
    expect(m.selectedRun).toBe("default/20260803-104655-x-gate");
    const pointer = m.getActiveRunPointer();
    expect(pointer).toBe("default/20260803-104655-x-gate");
    expect(pointer).not.toContain(root);
    expect(pointer!.startsWith("/")).toBe(false);
    m.dispose();
  });

  it("live tail forwards meta and each record in order as they land, runId-tagged", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = stageRun(root, "p1");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(bridge.postRunPulse).not.toHaveBeenCalled();

    writeFileSync(join(run, "run.log"), META_LINE + "AMICODE_PULSE iter=1 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(bridge.postRunPulseMeta).toHaveBeenCalledWith("p1", expect.objectContaining({ drives: 1 }));
    expect(bridge.postRunPulse).toHaveBeenCalledWith("p1", 1, expect.any(Number), expect.any(Array));

    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=2 dt=0.2 a=0.3,0.4\n");
    tick(m);
    expect(bridge.postRunPulse).toHaveBeenLastCalledWith("p1", 2, expect.any(Number), expect.any(Array));
    m.dispose();
  });

  it("replay-seeded meta arms the live stream: tailed records flow without a re-sent meta", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const run = stageRun(root, "p2", { log: META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n" });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(bridge.postRunPulseMeta).toHaveBeenCalled();

    bridge.postRunPulse.mockClear();
    appendFileSync(join(run, "run.log"), "AMICODE_PULSE iter=4 dt=0.2 a=0.3,0.4\n");
    tick(m);
    expect(bridge.postRunPulse).toHaveBeenCalledWith("p2", 4, expect.any(Number), expect.any(Array));
    m.dispose();
  });
});

describe("RunsManager multi-run (#57 / #58 fan-out)", () => {
  beforeEach(() => {
    for (const f of Object.values(bridge)) f.mockClear();
  });

  it("two concurrent live runs: newest auto-selected; both fanned to the bridge", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.selectedRun).toBe("rA");

    const b = stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB");
    bridge.postRunIteration.mockClear();

    appendFileSync(join(a, "run.log"), "AMICODE_ITER iter=7 f=0.1 inf_pr=1e-8 inf_du=1e-6\n");
    tick(m);
    expect(bridge.postRunIteration).toHaveBeenCalledWith("rA", 7, expect.any(Number), expect.any(Number), expect.any(Number));
    expect(m.runs().find((r) => r.runId === "rA")?.latestIter).toBe(7);

    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9995\niterations = 7\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    tick(m);
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("rA", 0.9995, expect.any(Number), "completed");
    expect(m.runs().find((r) => r.runId === "rA")).toMatchObject({ phase: "finished", fidelity: 0.9995 });
    expect(promote).toHaveBeenCalledTimes(1);

    writeFileSync(join(b, "FINISHED"), 'status = "failed"\nexit_code = 3\n');
    tick(m);
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("rB", expect.any(Number), expect.any(Number), "failed");
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
    tick(m);
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB");

    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    bridge.postRunCompletion.mockClear();
    m.selectRun("rA");
    expect(bridge.postRunActivate).toHaveBeenCalledWith("rA");
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("rA", 0.9999, expect.any(Number), "completed");
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    m.dispose();
  });

  it("PULSE events are fanned to the bridge runId-tagged even for a background run", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA", { log: META_LINE });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB");
    bridge.postRunPulse.mockClear();

    appendFileSync(join(a, "run.log"), "AMICODE_PULSE iter=5 dt=0.2 a=0.1,0.2\n");
    tick(m);
    expect(bridge.postRunPulse).toHaveBeenCalledWith("rA", 5, expect.any(Number), expect.any(Array));
    m.dispose();
  });

  it("selecting a run whose FINISHED landed inside the poll window shows completion", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const a = stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    bridge.postRunCompletion.mockClear();

    writeFileSync(join(a, "result.toml"), 'schema_version = "1"\nfidelity = 0.9999\niterations = 3\n');
    writeFileSync(join(a, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    m.selectRun("rA");
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("rA", 0.9999, expect.any(Number), "completed");
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

  it("scheduler `started` registers + selects the run immediately", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();

    let emit!: (e: SchedulerLifecycleEvent) => void;
    const scheduler: SchedulerLike = {
      onEvent: (l) => {
        emit = l;
        return () => {};
      },
    };
    m.attachScheduler(scheduler);

    const dir = join(root, "rSched");
    mkdirSync(dir);
    writeManifest(dir, "rSched");
    emit({ kind: "queued", queueId: "q1", position: 0 });
    emit({ kind: "started", queueId: "q1", runId: "rSched", runDir: dir });
    expect(m.selectedRun).toBe("rSched");
    expect(bridge.postRunLabel).toHaveBeenCalledWith("rSched", "rSched");
    expect(bridge.postRunActivate).toHaveBeenCalledWith("rSched");

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
    m.pokeDiscovery();
    expect(bridge.postRunCompletion).not.toHaveBeenCalled();
    m.selectRun("rDemo");
    expect(bridge.postRunLabel).toHaveBeenCalledWith("rDemo", "rDemo");
    expect(bridge.postRunActivate).toHaveBeenCalledWith("rDemo");
    expect(bridge.postRunPulse).toHaveBeenCalledWith("rDemo", 60, expect.any(Number), expect.any(Array));
    expect(bridge.postRunCompletion).toHaveBeenCalledWith("rDemo", 0.9998, expect.any(Number), "completed");
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    m.dispose();
  });
});

describe("RunsManager review-#70 fixes", () => {
  beforeEach(() => {
    for (const f of Object.values(bridge)) f.mockClear();
  });

  it("#1 explicit selection is PINNED — a new live run registering does not steal the view", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rA", { finished: "completed", fidelity: 0.9 });
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    m.selectRun("rA");
    expect(m.selectedRun).toBe("rA");
    bridge.postRunLabel.mockClear();

    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rA");
    expect(bridge.postRunLabel).not.toHaveBeenCalledWith("rB", "rB");
    expect(bridge.postRunActivate).not.toHaveBeenCalledWith("rB");
    expect(m.runs().find((r) => r.runId === "rB")?.phase).toBe("live");

    m.selectRun("rB");
    expect(m.selectedRun).toBe("rB");
    m.dispose();
  });

  it("#1 auto-follow still applies while nothing was explicitly selected", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rA");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    stageRun(root, "rB");
    tick(m);
    expect(m.selectedRun).toBe("rB");
    m.dispose();
  });

  it("#2 a torn/invalid FINISHED at discovery is retried, not finalized as status:undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const dir = join(root, "rTorn");
    mkdirSync(dir, { recursive: true });
    writeManifest(dir, "rTorn");
    writeFileSync(join(dir, "result.toml"), 'schema_version = "1"\nfidelity = 0.9997\niterations = 5\n');
    writeFileSync(join(dir, "FINISHED"), 'status = "comp');
    appendFileSync(join(root, "index"), "rTorn\t2026-07-04T00:00:00Z\t/s.jl\n");

    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(m.runs().find((r) => r.runId === "rTorn")).toMatchObject({ phase: "live" });

    writeFileSync(join(dir, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    tick(m);
    expect(m.runs().find((r) => r.runId === "rTorn")).toMatchObject({
      phase: "finished",
      status: "completed",
      fidelity: 0.9997,
    });
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    m.dispose();
  });

  it("#4 discovery ingests the run dir ONCE — no second display pass", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    stageRun(root, "rOne", { log: META_LINE + "AMICODE_PULSE iter=3 dt=0.2 a=0.1,0.2\n" });
    const displayPass = vi.spyOn(RunsManager.prototype as never as { displaySink(): unknown }, "displaySink");
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    expect(displayPass).not.toHaveBeenCalled();
    expect(bridge.postRunPulseMeta).toHaveBeenCalled();
    displayPass.mockRestore();
    m.dispose();
  });
});
