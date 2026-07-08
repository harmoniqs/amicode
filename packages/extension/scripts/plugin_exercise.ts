// Direct end-to-end exercise of the amicode_* plugin (spec A verification).
//
// The "never import the plugin in tests" rule is a vitest idiom (the module has
// load-time side effects + a single-export constraint that vitest's graph would
// trip on). Run standalone under bun it's fine: this drives each tool's real
// execute() against a temp AMICODE_PROBLEMS_DIR and asserts the workspace,
// event log, sentinels, and run ref. Exit 0 = pass.
//
//   PATH="$HOME/.bun/bin:$PATH" bun packages/extension/scripts/plugin_exercise.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-exercise-"));
process.env.AMICODE_PROBLEMS_DIR = tmp; // set BEFORE the dynamic import's module load

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
}

function lastSentinel(ret: string): any {
  const lines = ret.trim().split("\n");
  const last = lines[lines.length - 1];
  assert(last.startsWith("AMICODE_DIFF "), `last line is a sentinel — got: ${last.slice(0, 80)}`);
  return JSON.parse(last.slice("AMICODE_DIFF ".length));
}

const { AmicodeTools } = await import("../opencode-plugin/amicode_tools");
const pack: any = await AmicodeTools({});
const tools = pack.tool;

// create → pick_system → set_model → formulate → solve
const s0 = lastSentinel(
  await tools.amicode_problem.execute({ action: "create", name: "X gate on Q1", new_name: null }),
);
assert(s0.entity === "problem" && s0.action === "created", "problem/created sentinel");
const slug: string = s0.problem;

lastSentinel(await tools.amicode_pick_system.execute({ platform: "transmon", omega: 4.8, delta: -0.2, notes: null }));
lastSentinel(await tools.amicode_set_model.execute({ levels: 4, drive_max: 0.2, params: null }));
lastSentinel(
  await tools.amicode_formulate.execute({ problem: "gate_synthesis", target: "X", objective: null, constraints: null }),
);
const s4 = lastSentinel(
  await tools.amicode_solve.execute({
    run_dir: "/home/u/.amico/runs/default/20260703-190412-abcd",
    T: 10,
    N: 50,
    max_iter: 60,
    integrator: "MagnusGL4",
    tier: "vetted",
    note: "X gate",
  }),
);
assert(s4.entity === "run", "solve emits a run sentinel");

// verify (spec C) — record the free-tier re-rollout outcome on the Run entity
const s5 = lastSentinel(
  await tools.amicode_verify.execute({ agree: true, fidelity_rerolled: 0.998, fidelity_reported: 0.999 }),
);
assert(s5.entity === "run" && s5.action === "updated", "verify updates the run entity");

// Workspace layout
const ws = path.join(tmp, slug);
for (const f of [
  "entities/system.toml",
  "entities/system.json",
  "entities/formulation.toml",
  "entities/run.toml",
  "problem.json",
]) {
  assert(fs.existsSync(path.join(ws, f)), `workspace file ${f}`);
}

// Event log: >=5 events, monotonic seq, incl. the solve-params Formulation merge
const events = fs
  .readFileSync(path.join(ws, "events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
assert(events.length >= 5, `>=5 events (got ${events.length})`);
events.forEach((e: any, i: number) => assert(e.seq === i + 1, `monotonic seq at index ${i} (got ${e.seq})`));
const formEvents = events.filter((e: any) => e.entity === "formulation");
assert(formEvents.length >= 2, `formulation created + solve-merge update (got ${formEvents.length})`);
const sysEvents = events.filter((e: any) => e.entity === "system");
assert(
  sysEvents.some((e: any) => e.hash?.startsWith("sha256:")),
  "system events carry a content hash",
);

// Run ref parsed from run_dir's last two segments
const runs = JSON.parse(fs.readFileSync(path.join(ws, "runs.json"), "utf8"));
assert(
  runs.runs.length === 1 && runs.runs[0].run_id === "20260703-190412-abcd" && runs.runs[0].lab === "default",
  "runs.json ref",
);
assert(runs.runs[0].tier === "vetted", "run ref carries tier");

console.error(`OK — ${events.length} events, ${formEvents.length} formulation events, workspace "${slug}"`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
