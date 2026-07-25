import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";
import { validateManifest } from "../src/schemas.js";
import type { RunEvent, SpecStamp } from "../src/types.js";

// A fake julia that echoes the argv it received (so we can assert the routing) and
// emits the ITER/DONE sentinels so telemetry classification is exercised too.
const ECHO_AND_STREAM = `
console.log('ARGS ' + JSON.stringify(process.argv.slice(2)))
console.log('AMICODE_ITER iter=1 f=1.0e-2')
console.log('DONE fidelity=0.9999')
`;

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function argsFrom(evs: RunEvent[]): string[] {
  const line = evs.find((e) => e.kind === "log" && e.line.startsWith("ARGS ")) as Extract<RunEvent, { kind: "log" }>;
  return JSON.parse(line.line.slice("ARGS ".length)) as string[];
}

const RUNNER = "using Piccolo; Piccolo.Specs.solve_spec(ARGS[1]; run_dir=pwd())";

describe("LocalExecutor routes solvespec.problem_spec → Piccolo.Specs.solve_spec", () => {
  it("problem_spec PATH: spawns the generic runner with the spec path; run.toml written first; ITER/DONE classified", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-echo", ECHO_AND_STREAM);
    // the problem_spec is a path to an on-disk problem.toml
    const specPath = fakeJulia(root, "problem.toml", ""); // content irrelevant to the mock; must exist
    const spec: SpecStamp = { canonical: '{"kind":"control"}', problem_spec: specPath };

    const h = await new LocalExecutor().submit(undefined, {
      lab: "testlab",
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec,
    });

    // run.toml is observable the instant submit() resolves — written FIRST, conforms.
    const manifest = readToml(join(h.runDir, "run.toml"));
    expect(validateManifest(manifest).ok).toBe(true);
    expect(typeof manifest.script_path).toBe("string");
    expect((manifest.script_path as string).length).toBeGreaterThan(0);

    const evs = await collect(h.events);
    const args = argsFrom(evs);
    // routing: -e <runner> <specPath>, NOT `julia <script>`
    expect(args).toContain("-e");
    expect(args).toContain(RUNNER);
    expect(args[args.indexOf("-e") + 2]).toBe(specPath); // the trailing path arg → ARGS[1]

    // sentinels classified
    expect(evs.filter((e) => e.kind === "iter")).toHaveLength(1);
    expect(evs.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
  });

  it("problem_spec OBJECT: writes problem.toml into the run dir, routes the runner at it, run.toml still first", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-echo", ECHO_AND_STREAM);
    const inline = {
      schema_version: 1,
      kind: "control",
      system: { kind: "template", template: "TransmonSystem" },
      problem: { template: "SplinePulseProblem", N: 100 },
    };
    const spec: SpecStamp = { canonical: JSON.stringify(inline), problem_spec: inline };

    const h = await new LocalExecutor().submit(undefined, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec,
    });

    // manifest first + conforms
    expect(validateManifest(readToml(join(h.runDir, "run.toml"))).ok).toBe(true);

    const evs = await collect(h.events);
    const args = argsFrom(evs);
    const problemToml = join(h.runDir, "problem.toml");
    expect(args).toContain("-e");
    expect(args).toContain(RUNNER);
    expect(args[args.indexOf("-e") + 2]).toBe(problemToml);

    // the inline object was serialized to problem.toml in the run dir
    expect(existsSync(problemToml)).toBe(true);
    const written = parseToml(readFileSync(problemToml, "utf8")) as Record<string, unknown>;
    expect(written.kind).toBe("control");
    expect((written.system as Record<string, unknown>).template).toBe("TransmonSystem");
    expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
  });

  it("script_path (no problem_spec) still runs the script directly — no -e runner", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-echo", ECHO_AND_STREAM);
    const script = fakeJulia(root, "solve.jl", "");

    const h = await new LocalExecutor().submit(script, {
      runsRoot: join(root, "runs"),
      julia: { julia },
    });

    // manifest first + conforms; script_path is the script
    const manifest = readToml(join(h.runDir, "run.toml"));
    expect(validateManifest(manifest).ok).toBe(true);
    expect(manifest.script_path).toBe(script);

    const evs = await collect(h.events);
    const args = argsFrom(evs);
    expect(args).not.toContain("-e");
    expect(args).toContain(script);
    expect(await h.finished).toEqual({ status: "completed", exitCode: 0 });
  });
});
