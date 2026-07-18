// packages/amico-run/test/remote_executor.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";
import { RemoteExecutor, EXIT_INFERRED, type RemoteExecutorOpts } from "../src/remote_executor.js";
import { validateManifest, validateFinished } from "../src/schemas.js";
import { ConfigError, type RunEvent } from "../src/types.js";

async function withCloud(fn: (fake: FakeCloud) => Promise<void>): Promise<void> {
  const fake = new FakeCloud();
  await fake.start();
  try {
    await fn(fake);
  } finally {
    await fake.stop();
  }
}
const ex = (fake: FakeCloud, knobs: Partial<RemoteExecutorOpts> = {}): RemoteExecutor =>
  new RemoteExecutor({ config: { baseUrl: fake.base, token: fake.token }, pollMs: 10, ...knobs });

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("RemoteExecutor.submit — Δ2 wire shape + local mirror", () => {
  it("POSTs script CONTENT + filename with the Bearer credential; 202 → conforming mirror run dir", async () => {
    await withCloud(async (fake) => {
      fake.state.finished = { status: "completed" }; // settle on first poll
      const root = tmpRoot();
      const script = fakeJulia(root, "solve.jl", "// julia body");
      const h = await ex(fake).submit(script, { lab: "testlab", runsRoot: join(root, "runs") });
      await h.finished;
      // Δ2 wire shape
      expect(fake.submits).toHaveLength(1);
      expect(fake.submits[0].auth).toBe(`Bearer ${fake.token}`);
      expect(String(fake.submits[0].body.script)).toContain("// julia body"); // content, not a path
      expect(fake.submits[0].body.filename).toBe("solve.jl");
      // mirror run dir — same contract files LocalExecutor writes
      const manifest = readToml(join(h.runDir, "run.toml"));
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.lab_id).toBe("testlab");
      expect((manifest.julia as { binary: string }).binary).toBe("cloud");
      // sidecar (run.toml is additionalProperties:false — frozen), index, latest, run.log from t0
      expect(JSON.parse(readFileSync(join(h.runDir, "remote.json"), "utf8"))).toEqual({
        task_id: fake.taskId,
        base_url: fake.base,
      });
      expect(readFileSync(join(root, "runs", "index"), "utf8")).toContain(h.runId);
      expect(existsSync(join(root, "runs", "latest"))).toBe(true);
      expect(existsSync(join(h.runDir, "run.log"))).toBe(true);
    });
  });

  it("401 → ConfigError (config-class credential fault), NO run dir, NO index", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const script = fakeJulia(root, "s.jl", "");
      const bad = new RemoteExecutor({ config: { baseUrl: fake.base, token: "wrong" }, pollMs: 10 });
      await expect(bad.submit(script, { runsRoot: join(root, "runs") })).rejects.toThrow(ConfigError);
      expect(existsSync(join(root, "runs"))).toBe(false); // step-1 parity: nothing ran, no run dir
    });
  });

  it("non-202 (500) → plain Error (not config-class), NO run dir", async () => {
    await withCloud(async (fake) => {
      fake.submitStatus = 500;
      const root = tmpRoot();
      const script = fakeJulia(root, "s.jl", "");
      const p = ex(fake).submit(script, { runsRoot: join(root, "runs") });
      await expect(p).rejects.toThrow(/HTTP 500/);
      await expect(p).rejects.not.toThrow(ConfigError);
      expect(existsSync(join(root, "runs"))).toBe(false);
    });
  });

  it("missing script → ConfigError BEFORE any network call", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      await expect(ex(fake).submit(join(root, "nope.jl"), { runsRoot: join(root, "runs") })).rejects.toThrow(
        /script not found/,
      );
      expect(fake.submits).toHaveLength(0);
    });
  });
});

describe("terminal resolution (d) — status poll is authoritative, FINISHED mirrored locally", () => {
  for (const [status, exitCode] of [
    ["completed", 0],
    ["failed", 1],
    ["aborted", 130],
  ] as const) {
    it(`finished{${status}} → FINISHED{${status}, ${exitCode}}, events terminate ON the finished event`, async () => {
      await withCloud(async (fake) => {
        fake.state.finished = { status };
        const root = tmpRoot();
        const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
        const evs = await collect(h.events);
        expect(evs.at(-1)).toEqual({ kind: "finished", status, exitCode });
        expect(await h.finished).toEqual({ status, exitCode });
        const fin = readToml(join(h.runDir, "FINISHED"));
        expect(validateFinished(fin).ok).toBe(true);
        expect(fin).toEqual({ status, exit_code: exitCode });
      });
    });
  }
});

describe("poll streaming — stats/frames fed into the mirror (Δ4)", () => {
  it("stats become AMICODE_ITER lines in run.log AND iter events; re-served history is deduped", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [
        { iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" },
        { iter: 2, f: "3.0e-4", inf_pr: "1e-9", inf_du: "1e-7" },
      ];
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(4); // several polls over the SAME stats — dedup must hold
      fake.state.finished = { status: "completed" };
      const evs = await collect(h.events);
      const iters = evs.filter((e) => e.kind === "iter");
      expect(iters).toHaveLength(2); // not 2 × polls
      expect(iters[0]).toMatchObject({ fields: { iter: "1", f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" } });
      expect(evs.at(-1)!.kind).toBe("finished");
      // the mirror's run.log carries the exact synthesized lines (tail/backstop food)
      const log = readFileSync(join(h.runDir, "run.log"), "utf8");
      expect(log).toContain("AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6");
      expect(log.match(/AMICODE_ITER iter=1 /g)).toHaveLength(1);
    });
  });

  it("frames land as iter_NNN.png (S3 layout name); newest-wins high-water", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-bytes-7").toString("base64") };
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(2);
      fake.state.finished = { status: "completed" };
      await h.finished;
      expect(readFileSync(join(h.runDir, "iter_007.png"), "utf8")).toBe("png-bytes-7");
      expect(readdirSync(h.runDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0); // atomic write
    });
  });

  it("resolution (a): a 500ing frames endpoint changes NOTHING — run completes, no png, no error event", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.framesBroken = true;
      fake.state.finished = { status: "completed" };
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
      expect(readdirSync(h.runDir).filter((f) => f.endsWith(".png"))).toHaveLength(0);
    });
  });
});

describe("liveness lanes — resolutions (c) and (d)", () => {
  it("heartbeat: a successful status poll re-touches run.log's mtime (cloud liveness → disk signal)", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot(); // Pending, alive, no iters: pure warming
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(2);
      const cold = new Date(Date.now() - 11 * 60 * 1000); // age past the inspector's 10-min knob
      utimesSync(join(h.runDir, "run.log"), cold, cold);
      const seen = fake.statusPolls;
      await fake.waitForPolls(seen + 2); // ≥1 full poll after aging
      expect(Date.now() - statSync(join(h.runDir, "run.log")).mtimeMs).toBeLessThan(60_000);
      fake.state.finished = { status: "completed" };
      await h.finished;
    });
  });

  it("resolution (d): liveness=gone without FINISHED → inferred terminal failed/255 + breadcrumb", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.liveness = "gone";
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      expect(await h.finished).toEqual({ status: "failed", exitCode: EXIT_INFERRED });
      const fin = readToml(join(h.runDir, "FINISHED"));
      expect(fin).toEqual({ status: "failed", exit_code: EXIT_INFERRED });
      expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain(
        "AMICODE_REMOTE_LOST instance gone without FINISHED",
      );
    });
  });

  it("resolution (c): warming budget exhausted (Pending forever) → inferred terminal + best-effort abort", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot(); // stays Pending with no iters — never shows life
      const h = await ex(fake, { warmingBudgetMs: 150 }).submit(fakeJulia(root, "s.jl", ""), {
        runsRoot: join(root, "runs"),
      });
      expect(await h.finished).toEqual({ status: "failed", exitCode: EXIT_INFERRED });
      expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain("warming budget exhausted");
      // best-effort abort fired is asserted in Task 6 (postAbort is a no-op until then)
    });
  });

  it("resolution (d) client half: endpoint gone after life was seen → bounded inferred terminal", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state.task_status = "Running";
    fake.state.iters = [{ iter: 1, f: "1e-2", inf_pr: "1e-8", inf_du: "1e-6" }];
    const root = tmpRoot();
    const h = await ex(fake, { lostAfterMs: 200 }).submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
    });
    await fake.waitForPolls(2); // life seen — the warming budget is out of play
    await fake.stop(); // the endpoint disappears
    expect(await h.finished).toEqual({ status: "failed", exitCode: EXIT_INFERRED }); // bounded, no forever-pump
    expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain("poll endpoint unreachable");
  });
});
