// packages/extension/test/remote_warming.test.ts
// Δ9 / resolution (c): remote warming must NOT trip the local 10-min stall
// machinery — the executor's heartbeat mirrors cloud liveness into run.log's
// mtime, so stopPlan/liveStatus measure CLOUD silence. An actual poll outage
// then reads honestly (stalled → bounded inferred terminal).
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteExecutor, EXIT_INFERRED } from "@amicode/amico-run";
import { FakeCloud } from "../../amico-run/test/fake_cloud";
import { stopPlan, STALL_AFTER_MS } from "../src/run_controls";

describe("Δ9 — remote warming budget is the executor's, not the inspector's", () => {
  it("warming past the LOCAL stall threshold stays 'cooperative': the heartbeat keeps run.log's mtime live", async () => {
    const fake = new FakeCloud(); // Pending, alive, no iters — pure warming
    await fake.start();
    try {
      const root = mkdtempSync(join(tmpdir(), "runs-"));
      const script = join(root, "s.jl");
      writeFileSync(script, "//\n");
      const ex = new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10 });
      const h = await ex.submit(script, { runsRoot: root });
      await fake.waitForPolls(2);
      // simulate a long warming on the local clock: age the log past the knob…
      const cold = new Date(Date.now() - STALL_AFTER_MS - 60_000);
      utimesSync(join(h.runDir, "run.log"), cold, cold);
      const seen = fake.statusPolls;
      await fake.waitForPolls(seen + 2); // …then let ≥1 full successful poll land
      // the heartbeat re-touched mtime: inspector-side logic reads "alive"
      expect(Date.now() - statSync(join(h.runDir, "run.log")).mtimeMs).toBeLessThan(STALL_AFTER_MS);
      expect(stopPlan(h.runDir)).toBe("cooperative"); // NOT "force" — no zombie verdict for a warming remote run
      fake.state.finished = { status: "completed" }; // settle so no pump leaks past the test
      await h.finished;
    } finally {
      await fake.stop();
    }
  });

  it("a sustained poll OUTAGE reads honestly: no heartbeat, then a bounded inferred terminal", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = {
      task_status: "Running",
      liveness: "alive",
      iters: [{ iter: 1, f: "1e-2", inf_pr: "1e-8", inf_du: "1e-6" }],
    };
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const script = join(root, "s.jl");
    writeFileSync(script, "//\n");
    const ex = new RemoteExecutor({
      config: { baseUrl: fake.base, token: fake.token },
      pollMs: 10,
      lostAfterMs: 200, // test knob — the 10-min default in fast-forward
    });
    const h = await ex.submit(script, { runsRoot: root });
    await fake.waitForPolls(2); // life seen — warming budget out of play
    await fake.stop(); // the endpoint disappears
    const fin = await h.finished; // bounded by lostAfterMs (resolution (d) client half)
    expect(fin).toEqual({ status: "failed", exitCode: EXIT_INFERRED });
    expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain("AMICODE_REMOTE_LOST poll endpoint unreachable");
    expect(stopPlan(h.runDir)).toBe("already-finished"); // FINISHED written — Stop converges, never wedges
  });
});
