import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, hermeticOpsEnv } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";

// A cloud script that never writes run.log cannot stream ANYTHING to the Run
// Inspector, and the user pays the full queue + instance-boot wait to discover it.
//
// Why run.log and not stdout: /solves/{id}/stats greps AMICODE_ITER out of the
// run.log the sidecar syncs from the working directory. The runner's stdout goes to
// the SSM command stream, which no API exposes — verified on task
// e4b25689 (HTTP 200, stats: []) and again on 975a7c07 and 64b8.
//
// Three cloud runs in two days hit this, every one a hand-authored script:
//   x-gate-transmon-56    invented CubicSplinePulse kwargs, CallbackLogger, get_fidelity
//   x-gate-transmon-hpc   a Jul-28 script reused verbatim; ZeroOrderPulse into
//                         SplinePulseProblem, which Piccolo 1.19 rejects outright
//   x-gate-transmon-hpc-3 CubicSplinePulseProblem (undefined) and
//                         AltissimoOptions(intermediate_callback=…) (no such field)
// None wrote run.log. LOCAL runs are unaffected: LocalExecutor pipes the child's
// stdout into run.log itself (local_executor.ts:293), so the script need not.

const BUNDLE = join(__dirname, "..", "dist", "amico-run.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

/** A hand-rolled script that prints telemetry but never writes the file. */
const STDOUT_ONLY = `using Printf
@printf("AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6\\n")
println("DONE fidelity=0.99")
`;

/** What the bundled template does: print AND append to run.log under TASK_ID. */
const WRITES_RUN_LOG = `function emit(line)
    println(line)
    if haskey(ENV, "TASK_ID")
        open("run.log", "a") do io
            println(io, line)
        end
    end
end
emit("AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6")
emit("DONE fidelity=0.99")
`;

function scriptWith(root: string, name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  return p;
}

describe("cloud telemetry preflight", () => {
  it("refuses a remote launch whose script never writes run.log", () => {
    const root = tmpRoot();
    const script = scriptWith(root, "stdout_only.jl", STDOUT_ONLY);
    let out = { code: 0, stderr: "" };
    try {
      execFileSync("node", [BUNDLE, script, "--executor", "remote", "--runs-root", join(root, "runs")], {
        encoding: "utf8",
        // a cloud config must EXIST for the preflight to be reachable — with no
        // connection at all the missing-connection error takes precedence, which is
        // the more fundamental problem. Pointed at a dead port: the whole claim is
        // that we refuse before ever contacting it (next test).
        env: {
          ...process.env,
          ...hermeticOpsEnv(),
          AMICO_CLOUD_URL: "http://127.0.0.1:1",
          AMICO_CLOUD_TOKEN: "x",
        },
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      out = { code: err.status ?? -1, stderr: err.stderr ?? "" };
    }
    expect(out.code).toBe(64);
    expect(out.stderr).toMatch(/cannot stream telemetry/);
    // the message must be ACTIONABLE — the whole point is that a cloud failure
    // names nothing, so this one has to name both the cause and the fix
    expect(out.stderr).toMatch(/run\.log/);
    expect(out.stderr).toMatch(/stdout does not reach it/);
    expect(out.stderr).toMatch(/solve template/);
  });

  it("refuses BEFORE submitting — no cloud round trip, no run dir", () => {
    const root = tmpRoot();
    const script = scriptWith(root, "stdout_only.jl", STDOUT_ONLY);
    let stdout = "";
    try {
      stdout = execFileSync("node", [BUNDLE, script, "--executor", "remote", "--runs-root", join(root, "runs")], {
        encoding: "utf8",
        // a cloud URL that would hang/refuse if we ever got as far as submitting
        env: { ...process.env, ...hermeticOpsEnv(), AMICO_CLOUD_URL: "http://127.0.0.1:1", AMICO_CLOUD_TOKEN: "x" },
      });
    } catch (e) {
      stdout = (e as { stdout?: string }).stdout ?? "";
    }
    expect(stdout).not.toMatch(/AMICODE_FINISHED/);
  });

  it("passes a template-derived script and the run completes", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = {
      task_status: "Running",
      liveness: "alive",
      iters: [],
      runLog: "AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6",
      finished: { status: "completed" },
    };
    try {
      const root = tmpRoot();
      const script = scriptWith(root, "from_template.jl", WRITES_RUN_LOG);
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveP) => {
        let stdout = "";
        let stderr = "";
        const child = execFile("node", [BUNDLE, script, "--executor", "remote", "--runs-root", join(root, "runs")], {
          env: { ...process.env, ...hermeticOpsEnv(), AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: fake.token },
        });
        child.stdout!.on("data", (d: string) => {
          stdout += d;
        });
        child.stderr!.on("data", (d: string) => {
          stderr += d;
        });
        child.on("exit", (c) => resolveP({ code: c ?? -1, stdout, stderr }));
      });
      expect(r.stderr).not.toMatch(/cannot stream telemetry/);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0/);
    } finally {
      await fake.stop();
    }
  }, 15000);

  it("leaves LOCAL runs alone — LocalExecutor writes run.log from stdout itself", () => {
    // The same stdout-only script is perfectly fine locally, so the check must not
    // fire there or it would break every ordinary free-tier solve.
    const root = tmpRoot();
    const julia = fakeJulia(
      root,
      "j",
      `console.log('AMICODE_ITER iter=1 f=1.0e-2 inf_pr=1e-8 inf_du=1e-6'); console.log('DONE f=0.99')`,
    );
    const script = scriptWith(root, "stdout_only.jl", STDOUT_ONLY);
    const stdout = execFileSync(
      "node",
      [BUNDLE, script, "--runs-root", join(root, "runs"), "--julia", julia],
      { encoding: "utf8", env: { ...process.env, ...hermeticOpsEnv() } },
    );
    expect(stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0/);
  });
});
