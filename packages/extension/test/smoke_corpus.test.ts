import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscodeMock from "vscode";
import { LocalExecutor, Scheduler, type SchedulerEvent } from "@amicode/amico-run";

const bridge = vi.hoisted(() => ({
  postRunIteration: vi.fn(),
  postRunPulseMeta: vi.fn(),
  postRunPulse: vi.fn(),
  postRunCompletion: vi.fn(),
  postRunActivate: vi.fn(),
  postRunLabel: vi.fn(),
  postRunTiming: vi.fn(),
}));
vi.mock("../src/inspector_bridge", () => bridge);

import { RunsManager } from "../src/runs_manager";

const channel = { appendLine() {}, append() {} } as never;
const CORPUS = join(__dirname, "corpus");
const EMITTER = join(CORPUS, "fake-julia");

const tick = (m: RunsManager): void => (m as unknown as { tick(): void }).tick();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pumpUntil(m: RunsManager, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) {
    tick(m);
    await sleep(25);
  }
  tick(m);
  if (!pred()) throw new Error(`pumpUntil timed out after ${ms}ms waiting for: ${what}`);
}

describe("smoke corpus — Scheduler → executor → run-dir → RunsManager → bridge", () => {
  beforeEach(() => {
    for (const f of Object.values(bridge)) f.mockClear();
  });

  it("runs the corpus serially end-to-end; both runs tracked, runId-keyed, correct fidelity", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "smoke-corpus-"));
    const m = new RunsManager({ runsRoot, channel });
    m.start();
    const scheduler = new Scheduler(new LocalExecutor());
    m.attachScheduler(scheduler);
    const events: SchedulerEvent[] = [];
    scheduler.onEvent((e) => events.push(e));

    const opts = { runsRoot, julia: { julia: EMITTER } };
    const a = scheduler.enqueue({ scriptPath: join(CORPUS, "transmon_x.jl"), opts });
    const b = scheduler.enqueue({ scriptPath: join(CORPUS, "cavity_displacement.jl"), opts });

    const ha = await a.handle;
    await pumpUntil(m, () => existsSync(join(ha.runDir, "FINISHED")), "run A FINISHED on disk");
    expect((await ha.finished).status).toBe("completed");

    const hb = await b.handle;
    await pumpUntil(m, () => existsSync(join(hb.runDir, "FINISHED")), "run B FINISHED on disk");
    expect((await hb.finished).status).toBe("completed");

    const seq = events.map((e) => `${e.kind}:${e.queueId}`);
    expect(seq.indexOf("finished:q1")).toBeGreaterThan(seq.indexOf("started:q1"));
    expect(seq.indexOf("started:q2")).toBeGreaterThan(seq.indexOf("finished:q1"));
    expect(seq.indexOf("finished:q2")).toBeGreaterThan(seq.indexOf("started:q2"));

    for (const h of [ha, hb]) {
      for (const f of ["run.toml", "run.log", "result.toml", "FINISHED"]) {
        expect(existsSync(join(h.runDir, f)), `${f} missing in ${h.runDir}`).toBe(true);
      }
      expect(readFileSync(join(runsRoot, "index"), "utf8")).toContain(h.runId);
    }

    await pumpUntil(m, () => m.runs().filter((r) => r.phase === "finished").length === 2, "both runs terminal in the registry");
    expect(m.runs().find((r) => r.runId === ha.runId)).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9993, latestIter: 4 });
    expect(m.runs().find((r) => r.runId === hb.runId)).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9981, latestIter: 3 });

    expect(bridge.postRunActivate).toHaveBeenCalledWith(ha.runId);
    expect(bridge.postRunActivate).toHaveBeenCalledWith(hb.runId);
    expect(bridge.postRunCompletion).toHaveBeenCalledWith(ha.runId, 0.9993, expect.any(Number), "completed");
    expect(bridge.postRunCompletion).toHaveBeenCalledWith(hb.runId, 0.9981, expect.any(Number), "completed");
    expect(bridge.postRunPulseMeta).toHaveBeenCalledWith(ha.runId, expect.objectContaining({ drives: 2, knots: 8 }));
    expect(bridge.postRunPulseMeta).toHaveBeenCalledWith(hb.runId, expect.objectContaining({ drives: 1, knots: 6 }));
    expect(bridge.postRunIteration).toHaveBeenCalledWith(ha.runId, 4, expect.any(Number), expect.any(Number), expect.any(Number));
    expect(bridge.postRunIteration).toHaveBeenCalledWith(hb.runId, 3, expect.any(Number), expect.any(Number), expect.any(Number));

    m.dispose();
  }, 20000);

  it("failure lane: a crashing solve lands FINISHED{failed}, no result.toml, no fidelity", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "smoke-corpus-fail-"));
    const m = new RunsManager({ runsRoot, channel });
    m.start();
    const scheduler = new Scheduler(new LocalExecutor());
    m.attachScheduler(scheduler);
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");

    const f = scheduler.enqueue({ scriptPath: join(CORPUS, "failing_solve.jl"), opts: { runsRoot, julia: { julia: EMITTER } } });
    const hf = await f.handle;
    await pumpUntil(m, () => existsSync(join(hf.runDir, "FINISHED")), "failing run FINISHED on disk");
    expect((await hf.finished).status).toBe("failed");

    expect(existsSync(join(hf.runDir, "result.toml"))).toBe(false);
    await pumpUntil(m, () => m.runs().find((r) => r.runId === hf.runId)?.phase === "finished", "failed run terminal in the registry");
    expect(m.runs().find((r) => r.runId === hf.runId)).toMatchObject({ phase: "finished", status: "failed" });
    expect(m.runs().find((r) => r.runId === hf.runId)?.fidelity).toBeUndefined();
    expect(m.runs().find((r) => r.runId === hf.runId)?.latestIter).toBe(2);

    expect(bridge.postRunCompletion).toHaveBeenCalledWith(hf.runId, expect.any(Number), expect.any(Number), "failed");
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    m.dispose();
  }, 20000);
});
