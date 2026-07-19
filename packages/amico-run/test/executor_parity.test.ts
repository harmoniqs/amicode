// packages/amico-run/test/executor_parity.test.ts
// S7/S11 snapshot (Δ8 AC): the SAME solve through LocalExecutor and
// RemoteExecutor yields IDENTICAL downstream-observable state — event
// sequence (iter/finished), FINISHED bytes, AMICODE_ITER run.log lines.
// Frames are best-effort (S11): a broken frames endpoint changes nothing.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";
import { LocalExecutor } from "../src/local_executor.js";
import { RemoteExecutor } from "../src/remote_executor.js";
import { validateManifest, validateFinished } from "../src/schemas.js";
import type { RunEvent, RunHandle } from "../src/types.js";

const ITERS = [
  { iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" },
  { iter: 2, f: "3.0e-4", inf_pr: "1e-9", inf_du: "1e-7" },
];
const LOCAL_BODY = ITERS.map(
  (i) => `console.log('AMICODE_ITER iter=${i.iter} f=${i.f} inf_pr=${i.inf_pr} inf_du=${i.inf_du}')`,
).join("\n");

async function collect(h: RunHandle): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of h.events) out.push(e);
  return out;
}

/** What downstream actually consumes: iter/finished events + contract files. */
function observable(evs: RunEvent[], runDir: string) {
  return {
    events: evs
      .filter((e) => e.kind === "iter" || e.kind === "finished")
      .map((e) =>
        e.kind === "iter"
          ? { kind: e.kind, fields: e.fields }
          : { kind: e.kind, status: e.status, exitCode: e.exitCode },
      ),
    finishedFile: readFileSync(join(runDir, "FINISHED"), "utf8"),
    iterLines: readFileSync(join(runDir, "run.log"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("AMICODE_ITER")),
  };
}

describe("S7/S11 — Local vs Remote over the same solve", () => {
  it("terminal state, FINISHED bytes, run.log iter lines, event sequence: IDENTICAL", async () => {
    const lroot = tmpRoot();
    const lh = await new LocalExecutor().submit(fakeJulia(lroot, "s.jl", ""), {
      runsRoot: join(lroot, "runs"),
      julia: { julia: fakeJulia(lroot, "julia", LOCAL_BODY) },
    });
    const lobs = observable(await collect(lh), lh.runDir);

    const fake = new FakeCloud();
    await fake.start();
    fake.state = { task_status: "Running", liveness: "alive", iters: ITERS, finished: { status: "completed" } };
    try {
      const rroot = tmpRoot();
      const rh = await new RemoteExecutor({
        config: { baseUrl: fake.base, token: fake.token },
        pollMs: 10,
      }).submit(fakeJulia(rroot, "s.jl", ""), { runsRoot: join(rroot, "runs") });
      const robs = observable(await collect(rh), rh.runDir);
      expect(robs).toEqual(lobs); // S7: identical, not merely similar
      expect(validateManifest(readToml(join(lh.runDir, "run.toml"))).ok).toBe(true);
      expect(validateManifest(readToml(join(rh.runDir, "run.toml"))).ok).toBe(true);
      expect(validateFinished(readToml(join(rh.runDir, "FINISHED"))).ok).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it("S11: framesBroken changes NOTHING about the terminal state (frames best-effort)", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = {
      task_status: "Running",
      liveness: "alive",
      iters: ITERS,
      finished: { status: "completed" },
      framesBroken: true,
    };
    try {
      const root = tmpRoot();
      const h = await new RemoteExecutor({
        config: { baseUrl: fake.base, token: fake.token },
        pollMs: 10,
      }).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
      expect(existsSync(join(h.runDir, "FINISHED"))).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  it("S12 (amico-run side): scheduler.ts CODE names no executor type (scheduler.test.ts:285 idiom)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/scheduler.ts", import.meta.url)), "utf8")
      .replace(/\/\/.*$/gm, "") // comments may NAME executors (the header prose does)
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/LocalExecutor|RemoteExecutor|instanceof\s+\w*Executor/);
  });

  it("NAMED DIVERGENCE (Deviations #6): the remote failed lane pins exit_code 1 — local passes julia's real rc through", async () => {
    // Local: FINISHED{failed, <rc>} carries julia's ACTUAL exit code (pinned
    // by cli.test.ts:33-44, "julia rc 7 passes through as exit 7"). The Δ4
    // status shape carries NO exit code, so the remote mirror maps failed→1.
    // FINISHED bytes therefore DIFFER Local vs Remote on failure, by design —
    // this pin keeps the divergence intentional and guarded, not accidental.
    const fake = new FakeCloud();
    await fake.start();
    fake.state = { task_status: "Running", liveness: "alive", iters: [], finished: { status: "failed" } };
    try {
      const root = tmpRoot();
      const h = await new RemoteExecutor({
        config: { baseUrl: fake.base, token: fake.token },
        pollMs: 10,
      }).submit(fakeJulia(root, "s.jl", ""), { runsRoot: join(root, "runs") });
      expect(await h.finished).toEqual({ status: "failed", exitCode: 1 });
      expect(readFileSync(join(h.runDir, "FINISHED"), "utf8")).toBe('status = "failed"\nexit_code = 1\n');
    } finally {
      await fake.stop();
    }
  });
});
