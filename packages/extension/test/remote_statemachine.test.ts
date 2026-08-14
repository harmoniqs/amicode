// Δ9 (#33): a REMOTE run consumed through the SAME state machine as local
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bridge = vi.hoisted(() => ({
  postRunIteration: vi.fn(),
  postRunPulse: vi.fn(),
  postRunPulseMeta: vi.fn(),
  postRunCompletion: vi.fn(),
  postRunActivate: vi.fn(),
  postRunLabel: vi.fn(),
  postRunTiming: vi.fn(),
}));
vi.mock("../src/inspector_bridge", () => bridge);

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
    for (const f of Object.values(bridge)) f.mockClear();
  });

  it("warming → poll-delivered iters/frames → completion: same bridge calls as a local run", async () => {
    const fake = new FakeCloud();
    await fake.start();
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    const ex = new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 });
    try {
      const script = join(root, "s.jl");
      writeFileSync(script, "// content posted to the cloud\n");
      const h = await ex.submit(script, { runsRoot: root });
      tick(m);

      expect(bridge.postRunLabel).toHaveBeenCalledWith(h.runId, h.runId);
      expect(bridge.postRunActivate).toHaveBeenCalledWith(h.runId);
      expect(m.selectedRun).toBe(h.runId);

      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 7, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" }];
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-bytes").toString("base64") };
      await until(() => readFileSync(join(h.runDir, "run.log"), "utf8").includes("iter=7"));
      tick(m);
      expect(bridge.postRunIteration).toHaveBeenCalledWith(h.runId, 7, expect.any(Number), expect.any(Number), expect.any(Number));
      await until(() => existsSync(join(h.runDir, "iter_00007.png")));

      fake.state.finished = { status: "completed" };
      await h.finished;
      tick(m);
      expect(bridge.postRunCompletion).toHaveBeenCalledWith(h.runId, expect.any(Number), expect.any(Number), "completed");
    } finally {
      m.dispose();
      await fake.stop();
    }
  });

  it("scheduler lane: remote run via Scheduler.enqueue registers on `started` and completes", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = { task_status: "Running", liveness: "alive", iters: [], finished: { status: "completed" } };
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const m = new RunsManager({ runsRoot: root, channel });
    m.start();
    try {
      const s = new Scheduler(new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 }));
      m.attachScheduler(s);
      const script = join(root, "s.jl");
      writeFileSync(script, "//\n");
      const r = s.enqueue({ scriptPath: script, opts: { runsRoot: root } });
      const h = await r.handle;
      expect(m.selectedRun).toBe(h.runId);
      await h.finished;
      tick(m);
      expect(bridge.postRunCompletion).toHaveBeenCalledWith(h.runId, expect.any(Number), expect.any(Number), "completed");
    } finally {
      m.dispose();
      await fake.stop();
    }
  });
});
