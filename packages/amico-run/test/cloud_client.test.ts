// packages/amico-run/test/cloud_client.test.ts
// The thin cloud client (#460) — the extracted half of RemoteExecutor. The
// executor-side behavior (through the delegating RemoteExecutor) stays pinned
// by remote_executor.test.ts + executor_parity.test.ts UNCHANGED; these tests
// pin the client MODULE on its own terms: the wire methods, the wallclock
// ladder, the GPU receipt helpers, the mirror run dir, and the composing
// cloudRun() lifecycle standalone.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";
import {
  CloudClient,
  CloudMirror,
  cloudRun,
  createMirrorRunDir,
  emitGpuReceipt,
  gpuReceiptOf,
  wallclockCap,
  EXIT_INFERRED,
} from "../src/cloud_client.js";
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

const client = (fake: FakeCloud): CloudClient => new CloudClient({ baseUrl: fake.base, token: fake.token });

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// ── wallclockCap: the never-optional cap's ladder, live once ───────────────────
describe("wallclockCap — explicit > env > generous default", () => {
  it("explicit wins (even 0 — ?? semantics, the executor contract)", () => {
    expect(wallclockCap(300)).toBe(300);
    expect(wallclockCap(0, {})).toBe(0);
  });
  it("env beats the default; a garbage env value falls to 7200", () => {
    // NOTE the env var is AMICODE_REMOTE_MAX_WALLCLOCK_S (with the D) — the
    // shipped name since the 2026-08-18 GPU-plane pass; pinned by
    // remote_executor.test.ts's env-override lane.
    expect(wallclockCap(undefined, { AMICODE_REMOTE_MAX_WALLCLOCK_S: "1200" })).toBe(1200);
    expect(wallclockCap(undefined, { AMICODE_REMOTE_MAX_WALLCLOCK_S: "not-a-number" })).toBe(7200);
    expect(wallclockCap(undefined, { AMICODE_REMOTE_MAX_WALLCLOCK_S: "-5" })).toBe(7200);
    expect(wallclockCap(undefined, {})).toBe(7200);
  });
});

// ── the GPU receipt helpers (#425/#430) ────────────────────────────────────────
describe("gpuReceiptOf — defensive parse of the runner-contract fields", () => {
  it("keeps the well-formed fields, drops the rest", () => {
    expect(gpuReceiptOf({ status: "completed", gpu_sku: "H100-80GB", gpu_seconds: 900, cost_usd: 2.7 })).toEqual({
      gpu_sku: "H100-80GB",
      gpu_seconds: 900,
      cost_usd: 2.7,
    });
  });
  it("empty/absent/garbage fields → null (nothing to account)", () => {
    expect(gpuReceiptOf({ status: "completed" })).toBeNull();
    expect(gpuReceiptOf({ gpu_sku: "", gpu_seconds: -5, cost_usd: Number.NaN })).toBeNull();
  });
});

describe("emitGpuReceipt — the #430 ledger row + the mirror receipt.toml", () => {
  it("appends a validating receipt row and writes the toml; returns true", async () => {
    await withCloud(async (fake) => {
      const dir = tmpRoot();
      const ledger = join(dir, "ledger.jsonl");
      process.env.AMICO_LEDGER = ledger;
      try {
        expect(emitGpuReceipt(dir, fake.taskId, "failed", { gpu_sku: "H100-80GB", gpu_seconds: 60, cost_usd: 0.2 })).toBe(
          true,
        );
        const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows).toHaveLength(1);
        // pure spend — no fidelity field by design (must never feed priors)
        expect(rows[0]).toMatchObject({
          type: "receipt",
          task_id: fake.taskId,
          executor: "remote",
          gpu_sku: "H100-80GB",
          gpu_seconds: 60,
          cost_usd: 0.2,
          status: "failed",
        });
        expect(Object.keys(rows[0])).not.toContain("fidelity");
        const toml = readFileSync(join(dir, "receipt.toml"), "utf8");
        expect(toml).toContain('gpu_sku = "H100-80GB"');
        expect(toml).toContain('status = "failed"');
      } finally {
        delete process.env.AMICO_LEDGER;
      }
    });
  });
});

// ── the wire methods (FakeCloud pins the LIVE shapes) ─────────────────────────
describe("CloudClient.submitScript — the Δ2 wire", () => {
  it("POSTs script CONTENT + filename + max_wallclock with the Bearer credential", async () => {
    await withCloud(async (fake) => {
      await client(fake).submitScript("// julia body", "solve.jl", 7200);
      expect(fake.submits).toHaveLength(1);
      expect(fake.submits[0].auth).toBe(`Bearer ${fake.token}`);
      expect(String(fake.submits[0].body.script)).toContain("// julia body");
      expect(fake.submits[0].body.filename).toBe("solve.jl");
      expect(fake.submits[0].body.max_wallclock).toBe(7200);
      // returns the task id
      expect(await client(fake).submitScript("// body", "s.jl", 300)).toBe(fake.taskId);
    });
  });
  it("401 → ConfigError (config-class credential fault); 500 → plain Error", async () => {
    await withCloud(async (fake) => {
      const bad = new CloudClient({ baseUrl: fake.base, token: "wrong" });
      await expect(bad.submitScript("", "s.jl", 300)).rejects.toThrow(ConfigError);
      fake.submitStatus = 500;
      await expect(client(fake).submitScript("", "s.jl", 300)).rejects.toThrow(/HTTP 500/);
      await expect(client(fake).submitScript("", "s.jl", 300)).rejects.not.toThrow(ConfigError);
    });
  });
});

describe("CloudClient.status — the authoritative lane", () => {
  it("returns the parsed payload; a bad task throws the HTTP code", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.finished = { status: "completed", gpu_sku: "H100-80GB" };
      const s = await client(fake).status(fake.taskId);
      expect(s.task_status).toBe("Running");
      expect(s.finished).toMatchObject({ status: "completed", gpu_sku: "H100-80GB" });
      await expect(client(fake).status("no-such-task")).rejects.toThrow(/status HTTP 404/);
    });
  });
});

describe("CloudClient.iterLines — both stats record shapes, malformed skipped", () => {
  it("structured fields → reconstructed lines; {raw} key=value → verbatim relay", async () => {
    await withCloud(async (fake) => {
      fake.state.iters = [
        { iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" },
        { raw: "iter=7 f=8.727579e-04 inf_pr=2.670e-09 inf_du=1.838e+02" } as never,
        { raw: "no iter key here" } as never, // malformed → skipped, never NaN
      ];
      const lines = await client(fake).iterLines(fake.taskId);
      expect(lines).toEqual([
        { iter: 1, line: "AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6" },
        { iter: 7, line: "AMICODE_ITER iter=7 f=8.727579e-04 inf_pr=2.670e-09 inf_du=1.838e+02" },
      ]);
    });
  });
  it("advisory: a broken stats endpoint yields [] (status stays authoritative)", async () => {
    await withCloud(async (fake) => {
      expect(await client(fake).iterLines("no-such-task")).toEqual([]);
    });
  });
});

describe("CloudClient.pulseLines — verbatim raw relay", () => {
  it("returns each {raw} line untouched, meta included", async () => {
    await withCloud(async (fake) => {
      fake.state.pulse = [
        { raw: 'AMICODE_PULSE_META drives=2 knots=20 bounds=-1.0:1.0' },
        { raw: "AMICODE_PULSE iter=0 dt=0.5 a=0.1,0.2 d=0.0,0.0" },
      ];
      expect(await client(fake).pulseLines(fake.taskId)).toEqual([
        'AMICODE_PULSE_META drives=2 knots=20 bounds=-1.0:1.0',
        "AMICODE_PULSE iter=0 dt=0.5 a=0.1,0.2 d=0.0,0.0",
      ]);
    });
  });
});

describe("CloudClient.frame — presigned-url lane, best-effort", () => {
  it("fetches the presigned url (no auth — the signature IS the credential)", async () => {
    await withCloud(async (fake) => {
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-bytes-7").toString("base64") };
      const fr = await client(fake).frame(fake.taskId);
      expect(fr?.iter).toBe(7);
      expect(fr?.png.toString()).toBe("png-bytes-7");
    });
  });
  it("no frame (204) or a broken endpoint (500) → undefined, never a throw", async () => {
    await withCloud(async (fake) => {
      expect(await client(fake).frame(fake.taskId)).toBeUndefined(); // no frame state → 204
      fake.state.framesBroken = true;
      expect(await client(fake).frame(fake.taskId)).toBeUndefined();
    });
  });
});

describe("CloudClient.abort — the REQUEST, best-effort", () => {
  it("posts …/abort once and never rejects", async () => {
    await withCloud(async (fake) => {
      await client(fake).abort(fake.taskId);
      expect(fake.aborts).toBe(1);
    });
  });
});

// ── the mirror run dir (LocalExecutor steps 2–5 parity) ───────────────────────
describe("createMirrorRunDir — the contract files", () => {
  it("manifest validates, remote.json sidecar, run.log from t0, index + latest", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      const runsRoot = join(root, "runs");
      const { runId, runDir } = createMirrorRunDir({
        cfg: { baseUrl: fake.base, token: fake.token },
        taskId: fake.taskId,
        script: "/somewhere/solve.jl",
        lab: "testlab",
        labId: "testlab",
        runsRoot,
      });
      const manifest = readToml(join(runDir, "run.toml"));
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.lab_id).toBe("testlab");
      expect((manifest.julia as { binary: string }).binary).toBe("cloud");
      expect(JSON.parse(readFileSync(join(runDir, "remote.json"), "utf8"))).toEqual({
        task_id: fake.taskId,
        base_url: fake.base,
      });
      expect(existsSync(join(runDir, "run.log"))).toBe(true);
      expect(readFileSync(join(runsRoot, "index"), "utf8")).toContain(runId);
      expect(existsSync(join(runsRoot, "latest"))).toBe(true);
    });
  });
  it("an unwritable runs root → ConfigError before anything is minted", () => {
    const root = tmpRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "a file where a directory tree would need to be");
    expect(() =>
      createMirrorRunDir({
        cfg: { baseUrl: "https://x", token: "t" },
        taskId: "task",
        script: "s.jl",
        lab: "l",
        labId: "l",
        runsRoot: join(blocker, "runs"),
      }),
    ).toThrow(ConfigError);
  });
});

// ── CloudMirror standalone: one-shot poll → terminal settle ───────────────────
describe("CloudMirror — one poll pass over an existing task", () => {
  it("mirrors iters/pulse/frame, settles terminal, flows the GPU receipt", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" }];
      fake.state.pulse = [{ raw: "AMICODE_PULSE iter=0 dt=0.5 a=0.1,0.2 d=0.0,0.0" }];
      fake.state.frame = { iter: 7, png_base64: Buffer.from("png-7").toString("base64") };
      fake.state.finished = { status: "completed", gpu_sku: "H100-80GB", gpu_seconds: 900, cost_usd: 2.7 };
      const root = tmpRoot();
      const ledger = join(root, "ledger.jsonl");
      process.env.AMICO_LEDGER = ledger;
      try {
        const c = client(fake);
        const { runId, runDir } = createMirrorRunDir({
          cfg: { baseUrl: fake.base, token: fake.token },
          taskId: fake.taskId,
          script: `cloud://${fake.taskId}`,
          lab: "l",
          labId: "l",
          runsRoot: join(root, "runs"),
        });
        const mirror = new CloudMirror({ client: c, taskId: fake.taskId, runId, runDir });
        const s = await mirror.pollOnce();
        expect(s.finished?.status).toBe("completed");
        expect(mirror.settled).toBe(true);
        expect(mirror.result).toEqual({ status: "completed", exitCode: 0 });
        expect(validateFinished(readToml(join(runDir, "FINISHED"))).ok).toBe(true);
        const log = readFileSync(join(runDir, "run.log"), "utf8");
        expect(log).toContain("AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6");
        expect(log).toContain("AMICODE_PULSE iter=0 dt=0.5 a=0.1,0.2 d=0.0,0.0");
        expect(readFileSync(join(runDir, "iter_00007.png"), "utf8")).toBe("png-7");
        // the #430 receipt row flowed through the extracted path
        const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(rows.find((r) => r.type === "receipt")).toMatchObject({ task_id: fake.taskId, gpu_sku: "H100-80GB" });
        expect(existsSync(join(runDir, "receipt.toml"))).toBe(true);
      } finally {
        delete process.env.AMICO_LEDGER;
      }
    });
  });
  it("a non-terminal task stays unsettled — no FINISHED, honest snapshot", async () => {
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.iters = [{ iter: 2, f: "3.0e-4", inf_pr: "1e-9", inf_du: "1e-7" }];
      const root = tmpRoot();
      const c = client(fake);
      const { runId, runDir } = createMirrorRunDir({
        cfg: { baseUrl: fake.base, token: fake.token },
        taskId: fake.taskId,
        script: "s.jl",
        lab: "l",
        labId: "l",
        runsRoot: join(root, "runs"),
      });
      const mirror = new CloudMirror({ client: c, taskId: fake.taskId, runId, runDir });
      await mirror.pollOnce();
      expect(mirror.settled).toBe(false);
      expect(existsSync(join(runDir, "FINISHED"))).toBe(false);
      expect(readFileSync(join(runDir, "run.log"), "utf8")).toContain("AMICODE_ITER iter=2");
    });
  });
});

// ── cloudRun: the composing lifecycle, standalone (the delegation target) ─────
describe("cloudRun — submit → mirror → pump, no RemoteExecutor involved", () => {
  it("a completed run yields a contract run dir and a resolving finished promise", async () => {
    await withCloud(async (fake) => {
      fake.state.finished = { status: "completed" };
      const root = tmpRoot();
      const h = await cloudRun({
        cfg: { baseUrl: fake.base, token: fake.token },
        script: fakeJulia(root, "s.jl", "// body"),
        lab: "l",
        labId: "l",
        runsRoot: join(root, "runs"),
        maxWallclock: 7200,
        pollMs: 10,
      });
      const evs = await collect(h.events);
      expect(evs.at(-1)).toEqual({ kind: "finished", status: "completed", exitCode: 0 });
      expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
      expect(validateManifest(readToml(join(h.runDir, "run.toml"))).ok).toBe(true);
      expect(existsSync(join(h.runDir, "FINISHED"))).toBe(true);
      expect(readdirSync(h.runDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });
  });
  it("an aborted run maps to exit 130; liveness=gone infers failed/255 with a breadcrumb", async () => {
    await withCloud(async (fake) => {
      fake.state.finished = { status: "aborted" };
      const root = tmpRoot();
      const h = await cloudRun({
        cfg: { baseUrl: fake.base, token: fake.token },
        script: fakeJulia(root, "s.jl", ""),
        lab: "l",
        labId: "l",
        runsRoot: join(root, "runs"),
        maxWallclock: 300,
        pollMs: 10,
      });
      expect(await h.finished).toEqual({ status: "aborted", exitCode: 130 });
      expect(readToml(join(h.runDir, "FINISHED"))).toEqual({ status: "aborted", exit_code: 130 });
    });
    await withCloud(async (fake) => {
      fake.state.task_status = "Running";
      fake.state.liveness = "gone";
      const root = tmpRoot();
      const h = await cloudRun({
        cfg: { baseUrl: fake.base, token: fake.token },
        script: fakeJulia(root, "s.jl", ""),
        lab: "l",
        labId: "l",
        runsRoot: join(root, "runs"),
        maxWallclock: 300,
        pollMs: 10,
      });
      expect(await h.finished).toEqual({ status: "failed", exitCode: EXIT_INFERRED });
      expect(readFileSync(join(h.runDir, "run.log"), "utf8")).toContain(
        "AMICODE_REMOTE_LOST instance gone without FINISHED",
      );
    });
  });
  it("a rejected submit (401) throws ConfigError with NO run dir minted", async () => {
    await withCloud(async (fake) => {
      const root = tmpRoot();
      await expect(
        cloudRun({
          cfg: { baseUrl: fake.base, token: "wrong" },
          script: fakeJulia(root, "s.jl", ""),
          lab: "l",
          labId: "l",
          runsRoot: join(root, "runs"),
          maxWallclock: 300,
        }),
      ).rejects.toThrow(ConfigError);
      expect(existsSync(join(root, "runs"))).toBe(false);
    });
  });
});
