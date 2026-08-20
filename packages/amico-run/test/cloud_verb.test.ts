// packages/amico-run/test/cloud_verb.test.ts
// The `amico cloud` verb surface (#460): submit/status/mirror/abort/run over
// the thin client, tested against FakeCloud through the ctx.env injection
// (the AMICO_CLOUD_URL/AMICO_CLOUD_TOKEN pair — never the developer's real
// cloud.json). The live-path honesty lanes (absent config, unreachable
// endpoint — #423 NXDOMAIN is the current reality) degrade to one clear
// error line with a non-zero exit.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";
import { cloudVerb } from "../src/cloud_verb.js";
import { validateManifest, validateFinished } from "../src/schemas.js";

async function withCloud(fn: (fake: FakeCloud) => Promise<void>): Promise<void> {
  const fake = new FakeCloud();
  await fake.start();
  try {
    await fn(fake);
  } finally {
    await fake.stop();
  }
}

/** The verb ctx pointing at the fake — config via the env pair, like a test
 *  machine with AMICO_CLOUD_URL/AMICO_CLOUD_TOKEN exported. */
const ctxFor = (fake: FakeCloud) => ({ env: { AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: fake.token } });
const NO_CONFIG = { env: { AMICO_CLOUD_FILE: "/nonexistent/amico-test/cloud.json" } };

const out = (r: { json: unknown; code: number }): Record<string, unknown> => r.json as Record<string, unknown>;

// ── submit ───────────────────────────────────────────────────────────────────────
describe("amico cloud submit", () => {
  it("POSTs the script content + filename + the never-optional cap; prints the task id; NO run dir", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const script = fakeJulia(root, "solve.jl", "// julia body");
      const r = await cloudVerb(["submit", script, "--runs-root", join(root, "runs")], ctxFor(fake));
      expect(r.code).toBe(0);
      expect(out(r)).toMatchObject({
        verb: "cloud",
        subcommand: "submit",
        ok: true,
        task_id: fake.taskId,
        base_url: fake.base,
        filename: "solve.jl",
        max_wallclock: 7200, // the generous default — the ladder lives once
      });
      expect(fake.submits).toHaveLength(1);
      expect(fake.submits[0].auth).toBe(`Bearer ${fake.token}`);
      expect(String(fake.submits[0].body.script)).toContain("// julia body");
      expect(fake.submits[0].body.filename).toBe("solve.jl");
      expect(fake.submits[0].body.max_wallclock).toBe(7200);
      expect(existsSync(join(root, "runs"))).toBe(false); // submit submits — nothing ran yet
    });
  });
  it("--max-wallclock rides the payload verbatim; garbage is a usage error", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const script = fakeJulia(root, "s.jl", "");
      const r = await cloudVerb(["submit", script, "--max-wallclock", "300"], ctxFor(fake));
      expect(r.code).toBe(0);
      expect(fake.submits[0].body.max_wallclock).toBe(300);
      const bad = await cloudVerb(["submit", script, "--max-wallclock", "soon"], ctxFor(fake));
      expect(bad.code).toBe(64);
      expect(out(bad).ok).toBe(false);
      expect((out(bad).errors as string[])[0]).toContain("--max-wallclock");
    });
  });
  it("--spec submits the spec's script_path (relative to the spec dir); problem_spec is refused until P6a", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const script = fakeJulia(root, "spec_solve.jl", "// spec script body");
      const spec = join(root, "solvespec.json");
      // schema-minimal solvespec: script_path XOR problem_spec, everything the
      // schema allows to be absent is absent.
      writeFileSync(spec, JSON.stringify({ schema_version: "2", script_path: "spec_solve.jl", lab_id: "default" }));
      const r = await cloudVerb(["submit", "--spec", spec], ctxFor(fake));
      expect(r.code).toBe(0);
      expect(fake.submits[0].body.filename).toBe("spec_solve.jl");
      expect(String(fake.submits[0].body.script)).toContain("// spec script body");

      writeFileSync(spec, JSON.stringify({ schema_version: "2", problem_spec: { kind: "k" }, lab_id: "default" }));
      const refused = await cloudVerb(["submit", "--spec", spec], ctxFor(fake));
      expect(refused.code).toBe(64);
      expect((out(refused).errors as string[])[0]).toContain("problem_spec");
      expect(fake.submits).toHaveLength(1); // nothing new was submitted
    });
  });
  it("usage honesty: neither script nor spec / both / extra args / missing script", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      for (const args of [["submit"], ["submit", "a.jl", "--spec", "s.json"]]) {
        const r = await cloudVerb(args, ctxFor(fake));
        expect(r.code).toBe(64);
        expect(out(r).ok).toBe(false);
      }
      const missing = await cloudVerb(["submit", join(root, "nope.jl")], ctxFor(fake));
      expect((out(missing).errors as string[])[0]).toMatch(/script not found/);
      expect(fake.submits).toHaveLength(0);
    });
  });
  it("401 → the config-class credential fault, one line", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const r = await cloudVerb(
        ["submit", fakeJulia(root, "s.jl", "")],
        { env: { AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: "wrong" } },
      );
      expect(r.code).toBe(64);
      expect((out(r).errors as string[])[0]).toContain("cloud credential rejected (401)");
    });
  });
  it("no cloud config → honest config error, nothing ran", async () => {
    const root = tmpRoot();
    const r = await cloudVerb(["submit", fakeJulia(root, "s.jl", "")], NO_CONFIG);
    expect(r.code).toBe(64);
    expect((out(r).errors as string[])[0]).toContain("cloud config not found");
  });
});

// ── status ───────────────────────────────────────────────────────────────────────
describe("amico cloud status", () => {
  it("one poll, printed as JSON, with the derived terminal flag", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      const live = await cloudVerb(["status", "--task", fake.taskId], ctxFor(fake));
      expect(live.code).toBe(0);
      expect(out(live)).toMatchObject({
        ok: true,
        task_id: fake.taskId,
        task_status: "Running",
        liveness: "alive",
        terminal: false,
      });
      fake.state.finished = { status: "completed", gpu_sku: "H100-80GB" };
      const done = await cloudVerb(["status", "--task", fake.taskId], ctxFor(fake));
      expect(out(done)).toMatchObject({ terminal: true, finished: { status: "completed", gpu_sku: "H100-80GB" } });
    });
  });
  it("an unreachable endpoint degrades to ONE clear line (the #423 reality)", async () => {
    const fake = new FakeCloud();
    await fake.start();
    const ctx = ctxFor(fake);
    await fake.stop(); // the endpoint disappears
    const r = await cloudVerb(["status", "--task", fake.taskId], ctx);
    expect(r.code).toBe(64);
    expect(out(r).ok).toBe(false);
    const msg = (out(r).errors as string[])[0];
    expect(msg).toContain("fetch failed");
    expect(msg).toMatch(/ECONNREFUSED|EADDRNOTAVAIL|connection refused/i); // the cause surfaced, not buried
  });
  it("missing --task is a usage error", async () => {
    const r = await cloudVerb(["status"], NO_CONFIG);
    expect(r.code).toBe(64);
    expect((out(r).errors as string[])[0]).toContain("--task");
  });
});

// ── mirror ───────────────────────────────────────────────────────────────────────
describe("amico cloud mirror", () => {
  it("a TERMINAL task materializes a full contract run dir — artifacts, FINISHED, receipt", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" }];
      fake.state.pulse = [
        { raw: 'AMICODE_PULSE_META drives=2 knots=20 labels="a_1"' },
        { raw: "AMICODE_PULSE iter=0 dt=0.5 a=0.1,0.2 d=0.0,0.0" },
      ];
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-7").toString("base64") };
      fake.state.finished = { status: "completed", gpu_sku: "H100-80GB", gpu_seconds: 900, cost_usd: 2.7 };
      const root = tmpRoot();
      const ledger = join(root, "ledger.jsonl");
      process.env.AMICO_LEDGER = ledger;
      try {
        const r = await cloudVerb(
          ["mirror", "--task", fake.taskId, "--runs-root", join(root, "runs"), "--lab", "mlab"],
          ctxFor(fake),
        );
        expect(r.code).toBe(0);
        const j = out(r) as Record<string, unknown>;
        const runDir = j.run_dir as string;
        expect(j).toMatchObject({
          ok: true,
          task_id: fake.taskId,
          terminal: true,
          finished: { status: "completed", exit_code: 0 },
          iter_lines_mirrored: 1,
          pulse_lines_mirrored: 2,
          frames_mirrored: 1,
          newest_frame: "iter_00007.png",
          receipt_emitted: true,
        });
        // the run dir contract — indistinguishable from an executor-mirrored run
        const manifest = readToml(join(runDir, "run.toml"));
        expect(validateManifest(manifest).ok).toBe(true);
        expect(manifest.lab_id).toBe("mlab");
        expect(manifest.script_path).toBe(`cloud://${fake.taskId}`);
        expect(JSON.parse(readFileSync(join(runDir, "remote.json"), "utf8"))).toEqual({
          task_id: fake.taskId,
          base_url: fake.base,
        });
        expect(validateFinished(readToml(join(runDir, "FINISHED"))).ok).toBe(true);
        const log = readFileSync(join(runDir, "run.log"), "utf8");
        expect(log).toContain("AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6");
        expect(log.match(/AMICODE_PULSE_META/g)).toHaveLength(1);
        expect(readFileSync(join(runDir, "iter_00007.png"), "utf8")).toBe("png-7");
        expect(readFileSync(join(root, "runs", "index"), "utf8")).toContain(j.run_id as string);
        expect(existsSync(join(root, "runs", "latest"))).toBe(true);
        // AC3: the #430 receipt row flowed through the extracted path
        const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.find((x) => x.type === "receipt")).toMatchObject({
          task_id: fake.taskId,
          executor: "remote",
          gpu_sku: "H100-80GB",
          gpu_seconds: 900,
          cost_usd: 2.7,
        });
        expect(readFileSync(join(runDir, "receipt.toml"), "utf8")).toContain('gpu_sku = "H100-80GB"');
      } finally {
        delete process.env.AMICO_LEDGER;
      }
    });
  });
  it("a RUNNING task yields an honest snapshot — no FINISHED, a note, artifacts present", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 3, f: "5e-3", inf_pr: "1e-8", inf_du: "1e-6" }];
      const root = tmpRoot();
      const r = await cloudVerb(["mirror", "--task", fake.taskId, "--runs-root", join(root, "runs")], ctxFor(fake));
      expect(r.code).toBe(0);
      const j = out(r) as Record<string, unknown>;
      expect(j.terminal).toBe(false);
      expect(j.finished).toBeNull();
      expect(typeof j.note).toBe("string");
      expect(readFileSync(join(j.run_dir as string, "run.log"), "utf8")).toContain("AMICODE_ITER iter=3");
      expect(existsSync(join(j.run_dir as string, "FINISHED"))).toBe(false);
    });
  });
  it("an unknown task fails honestly and mints NOTHING (no run dir, no index row)", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const r = await cloudVerb(["mirror", "--task", "no-such-task", "--runs-root", join(root, "runs")], ctxFor(fake));
      expect(r.code).toBe(64);
      expect((out(r).errors as string[])[0]).toMatch(/status HTTP 404/);
      expect(existsSync(join(root, "runs"))).toBe(false);
    });
  });
  it("a bad --lab pointer is a config-class error", async () => {
    await withCloud(async (fake) => {
      const r = await cloudVerb(["mirror", "--task", fake.taskId, "--lab", "NOT A LAB"], ctxFor(fake));
      expect(r.code).toBe(64);
      expect((out(r).errors as string[])[0]).toContain("invalid lab pointer");
    });
  });
});

// ── abort ────────────────────────────────────────────────────────────────────────
describe("amico cloud abort", () => {
  it("posts the REQUEST and says plainly that the status poll owns the terminal", async () => {
    await withCloud(async (fake) => {
      const r = await cloudVerb(["abort", "--task", fake.taskId], ctxFor(fake));
      expect(r.code).toBe(0);
      expect(out(r)).toMatchObject({ ok: true, task_id: fake.taskId, requested: true });
      expect(fake.aborts).toBe(1);
    });
  });
  it("preflights the channel — an unreachable endpoint is honest, not a silent ok", async () => {
    const fake = new FakeCloud();
    await fake.start();
    const ctx = ctxFor(fake);
    await fake.stop();
    const r = await cloudVerb(["abort", "--task", fake.taskId], ctx);
    expect(r.code).toBe(64);
    expect((out(r).errors as string[])[0]).toContain("fetch failed");
    expect(fake.aborts).toBe(0);
  });
});

// ── run (the composing lifecycle) ────────────────────────────────────────────────
describe("amico cloud run", () => {
  it("submit → poll → mirror to terminal: completed run, launch-lane exit 0, receipt flows", async () => {
    await withCloud(async (fake) => {
      fake.state.finished = { status: "completed", gpu_sku: "H100-80GB", gpu_seconds: 60, cost_usd: 0.2 };
      const root = tmpRoot();
      const ledger = join(root, "ledger.jsonl");
      process.env.AMICO_LEDGER = ledger;
      try {
        const r = await cloudVerb(
          ["run", fakeJulia(root, "s.jl", "// body"), "--runs-root", join(root, "runs"), "--max-wallclock", "300"],
          ctxFor(fake),
        );
        expect(r.code).toBe(0);
        const j = out(r) as Record<string, unknown>;
        expect(j).toMatchObject({
          ok: true,
          task_id: fake.taskId,
          status: "completed",
          exit_code: 0,
          receipt_emitted: true,
        });
        expect(fake.submits[0].body.max_wallclock).toBe(300);
        expect(validateFinished(readToml(join(j.run_dir as string, "FINISHED"))).ok).toBe(true);
        expect(existsSync(join(j.run_dir as string, "receipt.toml"))).toBe(true);
        const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.find((x) => x.type === "receipt")).toMatchObject({ task_id: fake.taskId, executor: "remote" });
        expect(readdirSync(j.run_dir as string).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
      } finally {
        delete process.env.AMICO_LEDGER;
      }
    });
  });
  it("a failed solve: the lifecycle completed, the verdict rides status/exit_code — exit 1", async () => {
    await withCloud(async (fake) => {
      fake.state.finished = { status: "failed" };
      const root = tmpRoot();
      const r = await cloudVerb(
        ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs")],
        ctxFor(fake),
      );
      expect(r.code).toBe(1);
      const j = out(r) as Record<string, unknown>;
      expect(j.ok).toBe(false);
      expect(j).toMatchObject({ status: "failed", exit_code: 1 });
      expect(existsSync(join(j.run_dir as string, "FINISHED"))).toBe(true);
    });
  });
  it("a rejected submit (401) → the config-class lane, exit 64, no run dir", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const r = await cloudVerb(
        ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs")],
        { env: { AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: "wrong" } },
      );
      expect(r.code).toBe(64);
      expect((out(r).errors as string[])[0]).toContain("cloud credential rejected (401)");
      expect(existsSync(join(root, "runs"))).toBe(false);
    });
  });
});

// ── the router seam ──────────────────────────────────────────────────────────────
describe("amico cloud — routing + usage", () => {
  it("unknown / missing subcommand → usage, exit 64", async () => {
    for (const args of [[], ["nope"]]) {
      const r = await cloudVerb(args, NO_CONFIG);
      expect(r.code).toBe(64);
      const j = out(r);
      expect(j.verb).toBe("cloud");
      expect(String(j.usage)).toContain("amico cloud submit");
    }
  });
});
