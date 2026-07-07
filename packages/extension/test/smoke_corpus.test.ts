import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscodeMock from "vscode";
import { LocalExecutor, Scheduler, type SchedulerEvent } from "@amicode/amico-run";

// Smoke corpus (1.4a, #61) — the END-TO-END lane: real Scheduler (#56) → real
// LocalExecutor → real run-dir contract on disk → real RunsManager (#57)
// tailing runs/index → inspector host surface (#58, runId-keyed). The only
// stand-in is the solver binary: test/corpus/fake-julia interprets each corpus
// fixture's AMICODE_SMOKE directive and emits the template's telemetry stream
// at seconds-scale, so this runs in the fast CI tier with zero Julia cost.
//
// What this pins that the unit suites can't: the pieces AGREE — the executor's
// run.log/index/FINISHED writes are exactly what the manager's tailer/registry
// read, scheduler lifecycle events satisfy the manager's structural seam, and
// per-run telemetry lands runId-keyed on the inspector with no cross-tagging.
// (#62 wires this into CI as a required gate.)
//
// SCOPE — don't over-trust (review #78): fake-julia is an independent encoding
// of the AMICODE_* grammar, so this suite guards WIRING (fake ↔ parser), NOT
// FORMAT (template ↔ parser). A solve_template.jl emit-format change stays
// green here while real solves break; that boundary is #83's format guard.

const { inspector } = vi.hoisted(() => ({
  inspector: {
    setWarmingUp: vi.fn(),
    postTiming: vi.fn(),
    postCompletion: vi.fn(),
    postIterationRecord: vi.fn(),
    postPulse: vi.fn(),
    setRunLabel: vi.fn(),
    activate: vi.fn(),
    reveal: vi.fn(),
  },
}));
vi.mock("../src/run_inspector", () => ({ getInspector: () => inspector }));

import { RunsManager } from "../src/runs_manager";

const channel = { appendLine() {}, append() {} } as never;
const CORPUS = join(__dirname, "corpus");
const EMITTER = join(CORPUS, "fake-julia");

const tick = (m: RunsManager): void => (m as unknown as { tick(): void }).tick();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pump the manager's poll path until `pred` holds (the 700ms wall-clock poll
 *  is too slow for a test — tick() is the same code path, deterministic).
 *  THROWS on timeout (review #78): a wiring regression must fail fast at the
 *  offending await, not surface as an opaque suite hang. */
async function pumpUntil(m: RunsManager, pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) {
    tick(m);
    await sleep(25);
  }
  tick(m);
  if (!pred()) throw new Error(`pumpUntil timed out after ${ms}ms waiting for: ${what}`);
}

describe("smoke corpus — Scheduler → executor → run-dir → RunsManager → inspector", () => {
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  it("runs the corpus serially end-to-end; both runs tracked, runId-keyed, correct fidelity", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "smoke-corpus-"));
    const m = new RunsManager({ runsRoot, channel });
    m.start();
    const scheduler = new Scheduler(new LocalExecutor());
    m.attachScheduler(scheduler);
    const events: SchedulerEvent[] = [];
    scheduler.onEvent((e) => events.push(e));

    // Enqueue the WHOLE corpus up front — the second entry must wait (serial).
    const opts = { runsRoot, julia: { julia: EMITTER } };
    const a = scheduler.enqueue({ scriptPath: join(CORPUS, "transmon_x.jl"), opts });
    const b = scheduler.enqueue({ scriptPath: join(CORPUS, "cavity_displacement.jl"), opts });

    const ha = await a.handle; // head of queue — starts immediately
    await pumpUntil(m, () => existsSync(join(ha.runDir, "FINISHED")), "run A FINISHED on disk");
    expect((await ha.finished).status).toBe("completed");

    const hb = await b.handle; // resolves only after A finished (serial)
    await pumpUntil(m, () => existsSync(join(hb.runDir, "FINISHED")), "run B FINISHED on disk");
    expect((await hb.finished).status).toBe("completed");

    // --- scheduler lifecycle: strict serial ordering, queueIds line up ---
    const seq = events.map((e) => `${e.kind}:${e.queueId}`);
    expect(seq.indexOf("finished:q1")).toBeGreaterThan(seq.indexOf("started:q1"));
    expect(seq.indexOf("started:q2")).toBeGreaterThan(seq.indexOf("finished:q1")); // B started strictly after A finished
    expect(seq.indexOf("finished:q2")).toBeGreaterThan(seq.indexOf("started:q2"));

    // --- run-dir contract on disk for BOTH runs (what the executor wrote is
    //     exactly what the manager read) ---
    for (const h of [ha, hb]) {
      for (const f of ["run.toml", "run.log", "result.toml", "FINISHED"]) {
        expect(existsSync(join(h.runDir, f)), `${f} missing in ${h.runDir}`).toBe(true);
      }
      expect(readFileSync(join(runsRoot, "index"), "utf8")).toContain(h.runId);
    }

    // --- registry: both finished, fidelity + iter high-water from the stream ---
    await pumpUntil(
      m,
      () => m.runs().filter((r) => r.phase === "finished").length === 2,
      "both runs terminal in the registry",
    );
    expect(m.runs().find((r) => r.runId === ha.runId)).toMatchObject({
      phase: "finished",
      status: "completed",
      fidelity: 0.9993,
      latestIter: 4,
    });
    expect(m.runs().find((r) => r.runId === hb.runId)).toMatchObject({
      phase: "finished",
      status: "completed",
      fidelity: 0.9981,
      latestIter: 3,
    });

    // --- inspector fan-out: per-run, runId-keyed, no cross-tagging ---
    // Scheduler `started` selected each run as it began (auto-follow).
    expect(inspector.activate).toHaveBeenCalledWith(ha.runId);
    expect(inspector.activate).toHaveBeenCalledWith(hb.runId);
    // Completion runId-keyed with each fixture's fidelity.
    expect(inspector.postCompletion).toHaveBeenCalledWith(ha.runId, "completed", 0.9993);
    expect(inspector.postCompletion).toHaveBeenCalledWith(hb.runId, "completed", 0.9981);
    // Pulse stream per run: meta + records with the fixture's shape, and every
    // record tagged with ITS run — dims prove no stream-crossing (A is 2×8, B is 1×6).
    const pulses = (rid: string) => inspector.postPulse.mock.calls.filter((c) => c[0] === rid).map((c) => c[1]);
    const lastA = pulses(ha.runId)
      .filter((e) => e.type === "record")
      .at(-1);
    const lastB = pulses(hb.runId)
      .filter((e) => e.type === "record")
      .at(-1);
    expect(pulses(ha.runId).some((e) => e.type === "meta" && e.meta.drives === 2 && e.meta.knots === 8)).toBe(true);
    expect(pulses(hb.runId).some((e) => e.type === "meta" && e.meta.drives === 1 && e.meta.knots === 6)).toBe(true);
    expect(lastA.record).toMatchObject({ iter: 4 });
    expect(lastA.record.values).toHaveLength(2);
    expect(lastA.record.values[0]).toHaveLength(8);
    expect(lastB.record).toMatchObject({ iter: 3 });
    expect(lastB.record.values).toHaveLength(1);
    expect(lastB.record.values[0]).toHaveLength(6);
    // Iter telemetry keyed per run too.
    expect(inspector.postIterationRecord).toHaveBeenCalledWith(ha.runId, expect.objectContaining({ iter: 4 }));
    expect(inspector.postIterationRecord).toHaveBeenCalledWith(hb.runId, expect.objectContaining({ iter: 3 }));

    m.dispose();
  }, 20000);

  it("failure lane: a crashing solve lands FINISHED{failed}, no result.toml, no fidelity, promote suppressed", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "smoke-corpus-fail-"));
    const m = new RunsManager({ runsRoot, channel });
    m.start();
    const scheduler = new Scheduler(new LocalExecutor());
    m.attachScheduler(scheduler);
    const promote = vi.spyOn(vscodeMock.window, "showInformationMessage");

    const f = scheduler.enqueue({
      scriptPath: join(CORPUS, "failing_solve.jl"),
      opts: { runsRoot, julia: { julia: EMITTER } },
    });
    const hf = await f.handle;
    await pumpUntil(m, () => existsSync(join(hf.runDir, "FINISHED")), "failing run FINISHED on disk");
    expect((await hf.finished).status).toBe("failed");

    // Run-dir contract for the failure lane: FINISHED written by the EXECUTOR
    // (never the script), and no result.toml (the emitter dies before it).
    expect(existsSync(join(hf.runDir, "result.toml"))).toBe(false);
    await pumpUntil(
      m,
      () => m.runs().find((r) => r.runId === hf.runId)?.phase === "finished",
      "failed run terminal in the registry",
    );
    expect(m.runs().find((r) => r.runId === hf.runId)).toMatchObject({ phase: "finished", status: "failed" });
    expect(m.runs().find((r) => r.runId === hf.runId)?.fidelity).toBeUndefined();
    // …but the telemetry it emitted BEFORE dying was tracked (iters 0-2).
    expect(m.runs().find((r) => r.runId === hf.runId)?.latestIter).toBe(2);

    // Completion fans runId-keyed with no fidelity; promote never fires.
    expect(inspector.postCompletion).toHaveBeenCalledWith(hf.runId, "failed", undefined);
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    m.dispose();
  }, 20000);
});
