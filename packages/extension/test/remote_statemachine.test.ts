// packages/extension/test/remote_statemachine.test.ts
// Δ9 (#33): a REMOTE run consumed through the SAME state machine as local —
// index-tail discovery, warming, run.log tail via the poll backstop, and
// FINISHED-keyed completion. Asserts the same inspector calls as the local
// flow in runs_manager.test.ts:90-112. ZERO extension production code changed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { RunsManager } from "../src/runs_manager";
import { RemoteExecutor, Scheduler } from "@amicode/amico-run";
import { FakeCloud } from "../../amico-run/test/fake_cloud";

const channel = { appendLine() {}, append() {} } as never;
const tick = (m: RunsManager): void => (m as unknown as { tick(): void }).tick();
const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("Δ9 — remote run through the SAME inspector state machine", () => {
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  it("warming → poll-delivered iters/frames → completion: same inspector calls as a local run", async () => {
    const fake = new FakeCloud(); // Pending, alive, no iters: warming
    await fake.start();
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    const ex = new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 });
    try {
      const script = join(root, "s.jl");
      writeFileSync(script, "// content posted to the cloud\n");
      const h = await ex.submit(script, { runsRoot: root }); // mirror dir + index line land NOW
      tick(m); // poll backstop drains the index → discovery (runs_manager.ts:170)

      // 1. warming — identical to the local fresh-run lane (runs_manager.test.ts:98-101)
      expect(inspector.setWarmingUp).toHaveBeenCalledWith(h.runId);
      expect(inspector.setRunLabel).toHaveBeenCalledWith(h.runId, h.runId);
      // …plus the cloud badge. End-to-end proof: a real RemoteExecutor.submit
      // wrote the remote.json this reads, so the pane a user actually sees
      // carries the Harmoniqs Cloud badge — not a dim string in the run label.
      expect(inspector.setCloudRun).toHaveBeenCalledWith(h.runId);
      expect(inspector.activate).toHaveBeenCalledWith(h.runId);
      expect(m.selectedRun).toBe(h.runId);

      // 2. poll-delivered iter + frame (Δ4 → mirror → run.log tail via the backstop)
      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 7, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" }];
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-bytes").toString("base64") };
      await until(() => readFileSync(join(h.runDir, "run.log"), "utf8").includes("iter=7"));
      tick(m); // backstop re-pokes the tail — the "no new paradigm" hinge
      expect(inspector.postIterationRecord).toHaveBeenCalledWith(h.runId, expect.objectContaining({ iter: 7 }));
      // 5-digit: the name BOTH the S3 layout and the local Julia solve use
      // (iter_00007.png). Was iter_007.png, which matched neither, so cloud
      // frames and local frames landed under two schemes in one run dir.
      await until(() => existsSync(join(h.runDir, "iter_00007.png"))); // frames mirrored best-effort

      // 3. completion — FINISHED authoritative via the status poll (resolution (d))
      fake.state.finished = { status: "completed" };
      await h.finished;
      tick(m); // same idempotent FINISHED re-check as local (checkFinished)
      expect(inspector.postCompletion).toHaveBeenCalledWith(h.runId, "completed", undefined);
      // fidelity undefined: result.toml mirroring is the NAMED Δ4 seam (status
      // shape doesn't carry it yet) — the CALL SHAPE is identical to local.
    } finally {
      m.dispose();
      await fake.stop();
    }
  });

  it("scheduler lane: remote run via Scheduler.enqueue registers on `started` and completes (S12 passthrough)", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = { task_status: "Running", liveness: "alive", iters: [], finished: { status: "completed" } };
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    try {
      const s = new Scheduler(
        new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 }),
      );
      m.attachScheduler(s);
      const script = join(root, "s.jl");
      writeFileSync(script, "//\n");
      const r = s.enqueue({ scriptPath: script, opts: { runsRoot: root } });
      const h = await r.handle; // the RunHandle IS the executor's (scheduler.test.ts:78)
      expect(m.selectedRun).toBe(h.runId); // `started` registered it — no index wait
      await h.finished;
      tick(m);
      expect(inspector.postCompletion).toHaveBeenCalledWith(h.runId, "completed", undefined);
    } finally {
      m.dispose();
      await fake.stop();
    }
  });
});

// Δ-next: the WHOLE cloud iteration chain, driven by a real run.log body.
//
// This is the test that was missing every time cloud iterations "didn't work".
// The three failures all lived in the seam between what the service returns and
// what the client expected, and every existing test seeded the CLIENT's shape, so
// they passed while real solves came back empty. Here the fake is handed a run.log
// and applies the deployed lambda's own extraction (statsFromRunLog), so the
// records under test are the ones the live endpoint produces: {raw: "iter=…"},
// key=value, never pre-parsed JSON.
//
// The run.log body is exactly what lands on the runner once aws-infra#230
// redirects julia's output there — including the Altissimo stdout-bridge lines,
// which are the version-independent telemetry path.
describe("cloud iterations reach the Inspector from a real run.log", () => {
  // Own reset: the inspector mock is module-level and the other block's beforeEach
  // does not reach here, so without this the "no iterations" case inherits the
  // previous test's calls and passes or fails for the wrong reason.
  beforeEach(() => {
    for (const f of Object.values(inspector)) f.mockClear();
  });

  const RUN_LOG = [
    "AMICODE_NOTE bridged AltissimoOptions onto DirectTrajOpt._solve (DTO 0.9.7 moved the extension point)",
    "  iter      objective      inf_pr      inf_du    lg(ρ)",
    "     ·   4.810437e+01   0.000e+00   1.074e+02      0.0",
    "AMICODE_ITER iter=1 f=8.831003e+01 inf_pr=0.000e+00 inf_du=4.104e+01",
    "AMICODE_ITER iter=2 f=1.203608e+01 inf_pr=0.000e+00 inf_du=8.812e+01",
    "AMICODE_ITER iter=3 f=7.804919e-03 inf_pr=1.078e-01 inf_du=6.604e+01",
    "DONE fidelity=0.9993",
  ].join("\n");

  it("key=value {raw} records become iteration records in the pane", async () => {
    const fake = new FakeCloud();
    await fake.start();
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    const ex = new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 });
    try {
      const script = join(root, "s.jl");
      writeFileSync(script, "//\n");
      const h = await ex.submit(script, { runsRoot: root });
      tick(m);

      fake.state.task_status = "Running";
      fake.state.runLog = RUN_LOG; // served through the REAL lambda transform

      // the highest iteration must arrive — proof the raw form parsed
      await until(() => readFileSync(join(h.runDir, "run.log"), "utf8").includes("iter=3"));
      tick(m);
      expect(inspector.postIterationRecord).toHaveBeenCalledWith(h.runId, expect.objectContaining({ iter: 3 }));

      // and the numeric fields survived the round trip — an iteration count with
      // no objective would plot as a flat line and read as "not converging"
      const call = inspector.postIterationRecord.mock.calls.find(
        (c: unknown[]) => (c[1] as { iter: number }).iter === 3,
      );
      expect((call![1] as { f_val: number }).f_val).toBeCloseTo(7.804919e-3, 12);

      // non-AMICODE_ITER lines (the NOTE, the raw Altissimo table) must not become
      // iterations — the lambda greps, so a loose parser would ingest the table too
      const iters = inspector.postIterationRecord.mock.calls.map((c: unknown[]) => (c[1] as { iter: number }).iter);
      expect(iters.every((n: number) => [1, 2, 3].includes(n))).toBe(true);

      fake.state.finished = { status: "completed" };
      await h.finished;
      tick(m);
      expect(inspector.postCompletion).toHaveBeenCalledWith(h.runId, "completed", undefined);
    } finally {
      m.dispose();
      await fake.stop();
    }
  }, 15000);

  it("an empty run.log yields no iterations and no crash (the observed live case)", async () => {
    // What every cloud solve returned before aws-infra#230: stats: []. The client
    // must treat that as "nothing yet", not as an error or a zero-th iteration.
    const fake = new FakeCloud();
    await fake.start();
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    const ex = new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 });
    try {
      const script = join(root, "s.jl");
      writeFileSync(script, "//\n");
      const h = await ex.submit(script, { runsRoot: root });
      tick(m); // discovery — without it the manager never registers the run
      fake.state.task_status = "Running";
      fake.state.runLog = "";
      fake.state.finished = { status: "completed" };
      await h.finished;
      tick(m);
      expect(inspector.postIterationRecord).not.toHaveBeenCalled();
      expect(inspector.postCompletion).toHaveBeenCalledWith(h.runId, "completed", undefined);
    } finally {
      m.dispose();
      await fake.stop();
    }
  }, 15000);
});
