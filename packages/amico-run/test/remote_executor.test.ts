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

  // Fetched from the frames endpoint's PRESIGNED URL (the live shape) rather than
  // from inline base64. The name is 5-digit because that is what BOTH the S3
  // layout and the local Julia solve write (iter_00007.png); the old 3-digit name
  // matched neither, so cloud frames and local frames landed under different
  // schemes in the same run dir.
  it("frames are fetched from the presigned url and land as iter_NNNNN.png; newest-wins high-water", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-bytes-7").toString("base64") };
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(2);
      fake.state.finished = { status: "completed" };
      await h.finished;
      expect(readFileSync(join(h.runDir, "iter_00007.png"), "utf8")).toBe("png-bytes-7");
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

describe("abort() — resolution (b): a REQUEST; the run is live until the real terminal", () => {
  it("posts …/abort once (idempotent), keeps streaming, settles ONLY when the poll reports aborted", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(1);
      const aborting = h.abort(); // request…
      void h.abort(); // …idempotent: no second POST
      await fake.waitForPolls(fake.statusPolls + 2); // the pump is STILL polling post-abort
      expect(fake.aborts).toBe(1);
      expect(existsSync(join(h.runDir, "FINISHED"))).toBe(false); // not terminal yet — request ≠ kill
      // the run keeps streaming after the abort request (still live)
      fake.state.iters = [{ iter: 3, f: "5e-3", inf_pr: "1e-8", inf_du: "1e-6" }];
      const seen = fake.statusPolls;
      await fake.waitForPolls(seen + 2);
      expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain("AMICODE_ITER iter=3");
      // the cloud finally reports the terminal — NOW everything settles
      fake.state.finished = { status: "aborted" };
      await aborting; // abort() resolves with the terminal, like LocalExecutor's
      expect(await h.finished).toEqual({ status: "aborted", exitCode: 130 });
      expect(readToml(join(h.runDir, "FINISHED"))).toEqual({ status: "aborted", exit_code: 130 });
    });
  });

  it("warming-budget exhaustion fires the best-effort abort request (Task 5 leftover)", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const h = await ex(fake, { warmingBudgetMs: 120 }).submit(fakeJulia(root, "s.jl", ""), {
        runsRoot: join(root, "runs"),
      });
      await h.finished;
      // the abort POST is fire-and-forget (`void postAbort()` — settle must not
      // depend on it), so the in-flight request can land AFTER finished resolves;
      // spin until it arrives (the FakeCloud.waitForPolls idiom; vitest's 5s
      // timeout bounds a never-fired request as a failure).
      while (fake.aborts < 1) await new Promise((r) => setTimeout(r, 5));
      expect(fake.aborts).toBe(1);
    });
  });
});

// ── the fake must match the LIVE service, not the client ────────────────────
// This whole class of bug was invisible because fake_cloud.ts served the shapes
// the client happened to read (`{iters}`, `{iter, png_base64}`) instead of the
// shapes the deployed API returns (`{stats}`, `{iter, key, url}`). Every test
// passed; every real cloud solve produced an empty run inspector. Recorded from
// task 419a57e6 on staging, 2026-07-28. If the service changes, change these
// AND fake_cloud.ts together — a fake that agrees with the client proves nothing.
describe("FakeCloud wire shapes match the live API", () => {
  it("/stats serves {task_id, stats[], submitter} — NOT {iters}", async () => {
    await withCloud(async (fake) => {
      fake.state.iters = [{ iter: 3, f: "1.0e-3", inf_pr: "1e-9", inf_du: "1e-7" }];
      const r = await fetch(`${fake.base}/solves/${fake.taskId}/stats`, {
        headers: { authorization: `Bearer ${fake.token}` },
      });
      const body = (await r.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["stats", "submitter", "task_id"]);
      expect(body).not.toHaveProperty("iters");
      expect((body.stats as unknown[]).length).toBe(1);
    });
  });

  it("/frames serves a presigned url + key — NOT inline png_base64", async () => {
    await withCloud(async (fake) => {
      fake.state.frame = { iter: 12, png_base64: Buffer.from("bytes").toString("base64") };
      const r = await fetch(`${fake.base}/solves/${fake.taskId}/frames`, {
        headers: { authorization: `Bearer ${fake.token}` },
      });
      const body = (await r.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["iter", "key", "submitter", "task_id", "url"]);
      expect(body).not.toHaveProperty("png_base64");
      expect(body.key).toMatch(/iter_00012\.png$/); // 5-digit, the real S3 layout
      // and the url is fetchable WITHOUT auth — the signature is the credential
      const img = await fetch(body.url as string);
      expect(img.ok).toBe(true);
      expect(Buffer.from(await img.arrayBuffer()).toString()).toBe("bytes");
    });
  });
});

// The poller only json.loads an AMICODE_ITER payload starting with "{"; the solve
// template emits key=value text, so those records arrive as {raw}. Reading only
// `it.iter` skipped every one as NaN. The smoke test seeded JSON, so this drift
// survived until a live solve wrote a real run.log.
describe("stats records arrive in either shape", () => {
  it("a {raw} text record still becomes an AMICODE_ITER line and an iter event", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      // exactly what solves_poll's _stats yields for a template-emitted line
      fake.state.iters = [{ raw: "iter=7 f=8.727579e-04 inf_pr=2.670e-09 inf_du=1.838e+02" } as never]
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(3); // re-served each poll — dedup must still hold
      fake.state.finished = { status: "completed" };
      const evs = await collect(h.events);
      const iters = evs.filter((e) => e.kind === "iter");
      expect(iters).toHaveLength(1);
      const log = readFileSync(join(h.runDir, "run.log"), "utf8");
      expect(log).toContain("AMICODE_ITER iter=7 f=8.727579e-04 inf_pr=2.670e-09 inf_du=1.838e+02");
      expect(log.match(/AMICODE_ITER/g)).toHaveLength(1);
    });
  });

  it("a malformed record is skipped, not emitted as NaN", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [{ raw: "no iter key here" } as never, { raw: "iter=2 f=1.0e-3" } as never];
      const root = tmpRoot();
      const h = await ex(fake).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      await fake.waitForPolls(2);
      fake.state.finished = { status: "completed" };
      await h.finished;
      const log = readFileSync(join(h.runDir, "run.log"), "utf8");
      expect(log).toContain("AMICODE_ITER iter=2 f=1.0e-3");
      expect(log).not.toContain("NaN");
      expect(log.match(/AMICODE_ITER/g)).toHaveLength(1);
    });
  });
});
