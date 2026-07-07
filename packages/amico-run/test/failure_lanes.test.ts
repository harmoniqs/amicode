import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";

const sub = (root: string, julia: string, script: string) =>
  new LocalExecutor().submit(script, { runsRoot: join(root, "runs"), julia: { julia } });

describe("§6 failure matrix", () => {
  it("nonzero exit → FINISHED{failed, rc}", async () => {
    const root = tmpRoot();
    const h = await sub(root, fakeJulia(root, "j", "process.exit(3)"), fakeJulia(root, "s.jl", ""));
    expect(await h.finished).toEqual({ status: "failed", exitCode: 3 });
    expect(readToml(join(h.runDir, "FINISHED"))).toEqual({ status: "failed", exit_code: 3 });
  });

  it("crash before any output → FINISHED{failed}, manifest still valid", async () => {
    const root = tmpRoot();
    const h = await sub(root, fakeJulia(root, "j", 'throw new Error("boom")'), fakeJulia(root, "s.jl", ""));
    const f = await h.finished;
    expect(f.status).toBe("failed");
    expect(readToml(join(h.runDir, "run.toml")).run_id).toBe(h.runId);
  });

  it("spawn failure after manifest (X_OK dir → spawn error) → FINISHED{failed, 127}", async () => {
    const root = tmpRoot();
    // a directory passes step-1 X_OK validation, but spawn() itself errors → child.on('error')
    const dirAsJulia = join(root, "julia-dir");
    mkdirSync(dirAsJulia, { mode: 0o755 });
    const h = await sub(root, dirAsJulia, fakeJulia(root, "s.jl", ""));
    expect(await h.finished).toEqual({ status: "failed", exitCode: 127 });
    expect(readToml(join(h.runDir, "run.toml")).run_id).toBe(h.runId); // manifest survived
  });

  it("shell exec-failure rc passes through verbatim (wrapper execs missing target)", async () => {
    const root = tmpRoot();
    const wrapper = join(root, "julia-wrapper");
    writeFileSync(wrapper, '#!/usr/bin/env bash\nexec /nonexistent/amico-test-julia "$@"\n');
    chmodSync(wrapper, 0o755);
    const h = await sub(root, wrapper, fakeJulia(root, "s.jl", ""));
    const f = await h.finished;
    expect(f.status).toBe("failed");
    expect([126, 127]).toContain(f.exitCode); // bash version dependent; both are julia-rc passthrough
  });

  it("crash mid-stream: iter events delivered, then FINISHED{failed}", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(
      root,
      "j",
      `
      console.log('AMICODE_ITER iter=1 f=0.5')
      console.log('AMICODE_ITER iter=2 f=0.1')
      process.exit(3)`,
    );
    const h = await sub(root, julia, fakeJulia(root, "s.jl", ""));
    const evs: string[] = [];
    for await (const e of h.events) evs.push(e.kind);
    expect(evs.filter((k) => k === "iter")).toHaveLength(2);
    expect(evs.at(-1)).toBe("finished");
    expect((await h.finished).exitCode).toBe(3);
  });

  it("julia killed by an EXTERNAL signal (not abort) → FINISHED{failed, 128+sig}", async () => {
    const root = tmpRoot();
    // self-inflicted SIGTERM stands in for an external kill: abort() was never called,
    // so status must be failed (143), not aborted
    const julia = fakeJulia(root, "j", `process.kill(process.pid, 'SIGTERM')`);
    const h = await sub(root, julia, fakeJulia(root, "s.jl", ""));
    expect(await h.finished).toEqual({ status: "failed", exitCode: 143 });
  });

  it("manifest is on disk BEFORE julia spawns (script observes it in cwd at startup)", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `process.exit(require('node:fs').existsSync('run.toml') ? 0 : 7)`);
    const h = await sub(root, julia, fakeJulia(root, "s.jl", ""));
    expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
  });

  it("garbage / binary stdout never crashes the parser; classified as log", async () => {
    const root = tmpRoot();
    const h = await sub(
      root,
      fakeJulia(root, "j", `process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a])); console.log('ok')`),
      fakeJulia(root, "s.jl", ""),
    );
    expect((await h.finished).status).toBe("completed");
  });

  it("script that writes nothing at all still yields manifest + FINISHED", async () => {
    const root = tmpRoot();
    const h = await sub(root, fakeJulia(root, "j", ""), fakeJulia(root, "s.jl", ""));
    await h.finished;
    expect(readToml(join(h.runDir, "FINISHED")).status).toBe("completed");
  });

  it("script's own bogus FINISHED is overwritten by the orchestrator verdict", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(
      root,
      "j",
      `
      require('node:fs').writeFileSync('FINISHED', 'status = "completed"\\nexit_code = 0\\n')
      process.exit(9)`,
    );
    const h = await sub(root, julia, fakeJulia(root, "s.jl", ""));
    await h.finished;
    expect(readToml(join(h.runDir, "FINISHED"))).toEqual({ status: "failed", exit_code: 9 });
  });

  it("exactly one finished event; events iterator terminates", async () => {
    const root = tmpRoot();
    const h = await sub(root, fakeJulia(root, "j", "process.exit(0)"), fakeJulia(root, "s.jl", ""));
    let n = 0;
    for await (const e of h.events) if (e.kind === "finished") n++;
    expect(n).toBe(1);
  });

  it("no partial orchestrator file is ever observable (tight-loop reader, spec §8)", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(
      root,
      "j",
      `
      let i = 0
      const t = setInterval(() => { console.log('AMICODE_ITER iter=' + ++i + ' f=0.1')
        if (i >= 20) { clearInterval(t) } }, 10)`,
    );
    const h = await sub(root, julia, fakeJulia(root, "s.jl", ""));
    let sawTmp = false;
    let done = false;
    void h.finished.then(() => {
      done = true;
    });
    while (!done) {
      if (readdirSync(h.runDir).some((f) => f.includes(".tmp-"))) sawTmp = true;
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(sawTmp).toBe(false);
    expect(readToml(join(h.runDir, "FINISHED")).status).toBe("completed");
  });
});
