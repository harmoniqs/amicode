// `amico device` (issue #113, slice B3) — the dispatcher successor. Pure graph
// logic (device_graph.ts: loadGraph / evaluate / nextActions / the lock decision)
// is unit-tested against src; the status/next/lock bodies are exercised through
// `dist/amico.js` with $AMICO_DEVICE_DIR pointed at a seeded temp device dir. The
// `--now` flag pins the evaluation clock so age/staleness are deterministic.
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGraph,
  evaluate,
  nextActions,
  acquireDecision,
  releaseDecision,
  acceptsSubmission,
  parseStateJson,
  type CalibrationGraph,
  type NodeState,
} from "../src/device_graph.js";

const GRAPH_TOML = `
[node.resonator_spec]
depends_on = []
qubit = "Q1"
produces = ["resonator_freq"]
ttl_seconds = 86400
impl = "standard"
[node.qubit_spec]
depends_on = ["resonator_spec"]
qubit = "Q1"
produces = ["qubit_freq"]
ttl_seconds = 43200
impl = "standard"
[node.cz_gate]
depends_on = ["qubit_spec"]
qubit = "Q1"
produces = ["cz_fidelity"]
impl = "qilc"
fallback = "cz_gate_standard"
[node.cz_gate_standard]
depends_on = ["qubit_spec"]
qubit = "Q1"
produces = ["cz_fidelity"]
impl = "standard"
`;

function graph(): CalibrationGraph {
  const res = loadGraph(GRAPH_TOML);
  if (!res.ok) throw new Error(res.error);
  return res.graph;
}

const NOW = Date.parse("2026-07-09T02:00:00Z");
const FRESH = { ts: "2026-07-09T00:00:00Z", value: { resonator_freq: 6.1 }, status: "calibrated", job_id: "j1" } as NodeState;

// ── pure logic (device_graph.ts) ────────────────────────────────────────────────
describe("loadGraph", () => {
  it("builds nodes, topo order, depth, and rejects cycles", () => {
    const g = graph();
    expect(g.topoOrder[0]).toBe("resonator_spec");
    expect(g.depth("resonator_spec")).toBe(0);
    expect(g.depth("qubit_spec")).toBe(1);
    expect(g.depth("cz_gate")).toBe(2);
    const cyclic = loadGraph(`[node.a]\ndepends_on = ["b"]\nimpl="standard"\nproduces=[]\n[node.b]\ndepends_on = ["a"]\nimpl="standard"\nproduces=[]`);
    expect(cyclic.ok).toBe(false);
  });
});

describe("evaluate — honesty rule (uncharacterized / stale / suspect)", () => {
  it("no state → all uncharacterized; roots rank first", () => {
    const verdicts = evaluate(graph(), {}, NOW);
    expect(verdicts.every((v) => v.status === "uncharacterized")).toBe(true);
    expect(verdicts[0].node).toBe("resonator_spec"); // depth 0 ranks first
    expect(verdicts[0].ageSeconds).toBe(Infinity);
  });
  it("fresh root, unmeasured children → children uncharacterized (not fabricated)", () => {
    const verdicts = evaluate(graph(), { resonator_spec: FRESH }, NOW);
    const byNode = Object.fromEntries(verdicts.map((v) => [v.node, v]));
    expect(byNode.resonator_spec.status).toBe("calibrated");
    expect(byNode.qubit_spec.status).toBe("uncharacterized");
  });
  it("a result older than ttl → stale", () => {
    const old = { ts: "2026-07-01T00:00:00Z", value: { resonator_freq: 6.1 }, status: "calibrated" } as NodeState;
    const v = evaluate(graph(), { resonator_spec: old }, NOW).find((x) => x.node === "resonator_spec")!;
    expect(v.status).toBe("stale");
  });
  it("a fresh child of a stale parent → suspect", () => {
    const state = {
      resonator_spec: { ts: "2026-07-01T00:00:00Z", value: {}, status: "calibrated" } as NodeState, // stale
      qubit_spec: { ts: "2026-07-09T00:00:00Z", value: {}, status: "calibrated" } as NodeState, // fresh
    };
    const v = evaluate(graph(), state, NOW).find((x) => x.node === "qubit_spec")!;
    expect(v.status).toBe("suspect");
  });
});

describe("nextActions — premium (Intonatissimo) funnel", () => {
  it("unentitled qilc node is locked, carries the funnel + standard fallback, never the acronym", () => {
    const res = nextActions(graph(), { resonator_spec: FRESH }, NOW, { entitled: false, idle: true });
    const cz = res.ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(cz.locked).toBe(true);
    expect(cz.recommendedNode).toBe("cz_gate_standard");
    expect(cz.premium?.package).toBe("Intonatissimo");
    expect(cz.premium?.capability).toBe("closed-loop calibration");
    // the funnel names product + capability but NEVER the method acronym in the
    // USER-FACING copy (the `impl: "qilc"` enum is internal graph plumbing).
    expect(cz.premium?.invite).not.toMatch(/QILC/i);
    expect(cz.reason).not.toMatch(/QILC/i);
  });
  it("entitled → qilc node runs itself, not the fallback", () => {
    const res = nextActions(graph(), { resonator_spec: FRESH }, NOW, { entitled: true, idle: true });
    const cz = res.ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(cz.locked).toBe(false);
    expect(cz.recommendedNode).toBe("cz_gate");
  });
});

describe("benchmark-exclusivity lock decisions", () => {
  it("free → granted; same owner re-acquire → reentrant; other owner → refused", () => {
    const first = acquireDecision(undefined, "benchmark", "jj", "2026-07-09T02:00:00Z");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error();
    expect(acquireDecision(first.lock, "benchmark", "jj", "2026-07-09T09:00:00Z")).toMatchObject({ ok: true, reentrant: true });
    expect(acquireDecision(first.lock, "benchmark", "raghav", "2026-07-09T09:00:00Z").ok).toBe(false);
  });
  it("a benchmark lock blocks concurrent submission; release frees it", () => {
    const lock = { mode: "benchmark", owner: "jj", acquired_at: "2026-07-09T02:00:00Z" };
    expect(acceptsSubmission(lock)).toBe(false);
    expect(acceptsSubmission(undefined)).toBe(true);
    expect(releaseDecision(lock, "jj", false)).toMatchObject({ ok: true, released: true });
    expect(releaseDecision(lock, "someone-else", false).ok).toBe(false);
    expect(releaseDecision(lock, undefined, true)).toMatchObject({ ok: true, released: true });
  });
});

describe("parseStateJson never throws", () => {
  it("junk / non-object / good all degrade sanely", () => {
    expect(parseStateJson("not json")).toEqual({});
    expect(parseStateJson("[1,2,3]")).toEqual({});
    expect(parseStateJson(JSON.stringify({ a: { ts: "2026-01-01T00:00:00Z" } })).a?.ts).toBe("2026-01-01T00:00:00Z");
  });
});

// ── verb bodies through the bundle ──────────────────────────────────────────────
const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});
function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let root: string; // $AMICO_DEVICE_DIR
function seedDevice(device: string, opts: { state?: string } = {}): void {
  const dir = join(root, device);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "graph.toml"), GRAPH_TOML);
  if (opts.state) writeFileSync(join(dir, "state.json"), opts.state);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amico-device-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("amico device status (bundle)", () => {
  it("projects qubit rollup + measured metrics + node verdicts; honest overall", () => {
    seedDevice("snowbird", { state: JSON.stringify({ resonator_spec: FRESH }) });
    const r = run(["device", "status", "--device", "snowbird", "--now", "2026-07-09T02:00:00Z"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.overall).toBe("uncharacterized"); // unmeasured children keep the device honest
    expect(out.qubits).toEqual([{ qubit: "Q1", status: "uncharacterized", nodeCount: 4 }]);
    expect(out.metrics.resonator_freq.value).toBe(6.1);
    expect(out.accepts_submission).toBe(true);
  });
  it("no graph on disk → uncharacterized + error, exit 64 (never fabricated)", () => {
    const r = run(["device", "status", "--device", "ghost"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(64);
    const out = JSON.parse(r.stdout);
    expect(out.overall).toBe("uncharacterized");
    expect(out.error).toMatch(/no_graph/);
  });
  it("missing --device → 64", () => {
    expect(run(["device", "status"], { AMICO_DEVICE_DIR: root }).code).toBe(64);
  });
});

describe("amico device next (bundle)", () => {
  it("ranks actions; qilc node surfaces the premium funnel", () => {
    seedDevice("snowbird", { state: JSON.stringify({ resonator_spec: FRESH }) });
    const r = run(["device", "next", "--device", "snowbird", "--now", "2026-07-09T02:00:00Z"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.idle).toBe(true);
    const cz = out.ranked_actions.find((a: { node: string }) => a.node === "cz_gate");
    expect(cz.locked).toBe(true);
    expect(cz.premium.package).toBe("Intonatissimo");
  });
});

describe("amico device lock (bundle) — benchmark exclusivity (W-2)", () => {
  it("acquire → suspends fan-out + refuses concurrent submission; state persists", () => {
    seedDevice("snowbird");
    const r = run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj", "--now", "2026-07-09T02:00:00Z"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ acquired: true, suspends_fanout: true, accepts_submission: false });
    expect(existsSync(join(root, "snowbird", "lock.json"))).toBe(true);
  });
  it("a locked device reports idle=false + accepts_submission=false on next", () => {
    seedDevice("snowbird", { state: JSON.stringify({ resonator_spec: FRESH }) });
    run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj"], { AMICO_DEVICE_DIR: root });
    const r = run(["device", "next", "--device", "snowbird", "--now", "2026-07-09T02:00:00Z"], { AMICO_DEVICE_DIR: root });
    const out = JSON.parse(r.stdout);
    expect(out.idle).toBe(false);
    expect(out.accepts_submission).toBe(false);
    expect(out.lock.held).toBe(true);
  });
  it("a concurrent acquire by another owner is refused, exit 64", () => {
    seedDevice("snowbird");
    run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj"], { AMICO_DEVICE_DIR: root });
    const r = run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "raghav"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).acquired).toBe(false);
  });
  it("acquire is idempotent for the same owner (re-entrant)", () => {
    seedDevice("snowbird");
    run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj", "--now", "2026-07-09T02:00:00Z"], { AMICO_DEVICE_DIR: root });
    const r = run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj", "--now", "2026-07-09T09:00:00Z"], { AMICO_DEVICE_DIR: root });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.reentrant).toBe(true);
    expect(out.lock.acquired_at).toBe("2026-07-09T02:00:00.000Z"); // keeps the original time
  });
  it("release frees the device; status reports held:false", () => {
    seedDevice("snowbird");
    run(["device", "lock", "--device", "snowbird", "--acquire", "--owner", "jj"], { AMICO_DEVICE_DIR: root });
    const rel = run(["device", "lock", "--device", "snowbird", "--release", "--owner", "jj"], { AMICO_DEVICE_DIR: root });
    expect(rel.code).toBe(0);
    expect(JSON.parse(rel.stdout).released).toBe(true);
    expect(existsSync(join(root, "snowbird", "lock.json"))).toBe(false);
    const st = run(["device", "lock", "--device", "snowbird"], { AMICO_DEVICE_DIR: root });
    expect(JSON.parse(st.stdout).lock.held).toBe(false);
  });
  it("acquire without --owner → 64", () => {
    seedDevice("snowbird");
    expect(run(["device", "lock", "--device", "snowbird", "--acquire"], { AMICO_DEVICE_DIR: root }).code).toBe(64);
  });
  it("unknown subcommand → 64", () => {
    expect(run(["device", "frobnicate"], { AMICO_DEVICE_DIR: root }).code).toBe(64);
  });
});
