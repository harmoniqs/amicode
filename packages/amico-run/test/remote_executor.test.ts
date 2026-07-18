// packages/amico-run/test/remote_executor.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
