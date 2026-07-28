// Tests for the amicode_* tool pack's ledger client (opencode-plugin/ledger_client.ts) —
// Plan 3 / L1 Task 6. SINGLE-WRITER: every append/query shells to the `amico` CLI;
// this module never touches runs.jsonl directly. Every function degrades
// gracefully (never throws) — a ledger hiccup must never break a tool call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveAmicoBinFrom,
  appendStanza,
  queryLedger,
  resolveWorkspaceSpecContext,
  stampStructureHash,
  selectRecommendations,
  attemptErrorStanza,
  fallbackStanza,
  verdictStanza,
  resolveRunHashes,
  type LedgerQueryResult,
} from "../opencode-plugin/ledger_client";

function fakeBin(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

describe("resolveAmicoBinFrom", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-root-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("prefers the staged package-time launcher (<extensionRoot>/bin/launcher/amico)", () => {
    fs.mkdirSync(path.join(root, "bin", "launcher"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "launcher", "amico"), "#!/usr/bin/env bash\n");
    expect(resolveAmicoBinFrom(root)).toBe(path.join(root, "bin", "launcher", "amico"));
  });

  it("falls back to the dev sibling package (../amico-run/launcher/amico)", () => {
    const parent = path.dirname(root); // root = <parent>/extension-ish
    const siblingDir = path.join(parent, "amico-run", "launcher");
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, "amico"), "#!/usr/bin/env bash\n");
    try {
      expect(resolveAmicoBinFrom(root)).toBe(path.join(root, "..", "amico-run", "launcher", "amico"));
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it("returns undefined when neither layout exists", () => {
    expect(resolveAmicoBinFrom(root)).toBeUndefined();
  });
});

describe("appendStanza — shells `amico ledger append` (never touches runs.jsonl directly)", () => {
  let dir: string;
  const prevBin = process.env.AMICO_BIN;
  const prevLedger = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-client-"));
    // CONTAIN THE SIDE EFFECT. One test below deletes AMICO_BIN on purpose, to exercise
    // resolveAmicoBin()'s PATH branch — and on a machine where a REAL `amico` is
    // installed, that branch resolves it and appendStanza performs a REAL append. With
    // AMICO_LEDGER unset that lands in the developer's own ~/.amico/ledger/runs.jsonl.
    // Observed: 10 junk `burn` rows (ts:"t", class:"x") accumulated there, one per suite
    // run. Pointing the ledger at the temp dir keeps the PATH branch exercised while the
    // write goes somewhere disposable.
    process.env.AMICO_LEDGER = path.join(dir, "runs.jsonl");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.AMICO_BIN;
    else process.env.AMICO_BIN = prevBin;
    if (prevLedger === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prevLedger;
  });

  it("pipes the JSON stanza to the resolved bin's stdin and returns true on success", () => {
    const captured = path.join(dir, "captured.json");
    process.env.AMICO_BIN = fakeBin(
      dir,
      "amico-append-ok",
      `const fs=require('fs'); const data=fs.readFileSync(0,'utf8'); fs.writeFileSync(${JSON.stringify(captured)}, data); process.exit(0);`,
    );
    const rec = { type: "attempt_error", ts: "t", session: "s1", errors: [{ path: "problem.Q", msg: "bad" }] };
    expect(appendStanza(rec)).toBe(true);
    expect(JSON.parse(fs.readFileSync(captured, "utf8"))).toEqual(rec);
  });

  it("returns false (never throws) when the shelled command fails", () => {
    process.env.AMICO_BIN = fakeBin(dir, "amico-append-fail", `process.exit(64);`);
    expect(appendStanza({ type: "fallback", ts: "t", from_tier: "spec", reason: "x" })).toBe(false);
  });

  it("returns false when the bin cannot be resolved/executed at all", () => {
    process.env.AMICO_BIN = path.join(dir, "does-not-exist");
    expect(appendStanza({ type: "burn", ts: "t", class: "x", mechanism: "y" })).toBe(false);
  });

  it("without AMICO_BIN, falls through to import.meta.url-relative resolution + PATH without throwing", () => {
    delete process.env.AMICO_BIN;
    // No assertion on the boolean (whether a real `amico` happens to be on PATH in
    // this env is not the point) — the point is resolveAmicoBin()'s import.meta.url
    // branch executes cleanly under vitest's ESM transform and appendStanza never throws.
    // The side effect IS the point of the beforeEach's AMICO_LEDGER redirect: where a real
    // `amico` is installed this branch really does append, and it must not land in the
    // developer's own ledger.
    expect(() => appendStanza({ type: "burn", ts: "t", class: "x", mechanism: "y" })).not.toThrow();
    // Whatever it wrote (if anything) went to the temp ledger, never to ~/.amico.
    const real = path.join(os.homedir(), ".amico", "ledger", "runs.jsonl");
    const before = fs.existsSync(real) ? fs.statSync(real).mtimeMs : 0;
    appendStanza({ type: "burn", ts: "t", class: "x", mechanism: "y" });
    const after = fs.existsSync(real) ? fs.statSync(real).mtimeMs : 0;
    expect(after).toBe(before); // the real ledger is untouched
  });
});

describe("queryLedger — shells `amico ledger query`, degrades gracefully", () => {
  let dir: string;
  const prevBin = process.env.AMICO_BIN;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-client-q-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.AMICO_BIN;
    else process.env.AMICO_BIN = prevBin;
  });

  it("parses the CLI's JSON stdout and passes the raw structure_hash/n/t through as args", () => {
    const argsFile = path.join(dir, "args.json");
    process.env.AMICO_BIN = fakeBin(
      dir,
      "amico-query-ok",
      `const fs=require('fs');
       fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
       console.log(JSON.stringify({
         key: "primary", structure_hash: "abc", total: 2, verified: 1,
         params: { Q: { value: 150000, iqr: [100000, 200000], n: 2 } },
         provenance: "n=2 runs, 1 verified (primary key)", confidence: "medium",
       }));`,
    );
    const r = queryLedger("abc", 100, 100);
    expect(r).toMatchObject({ total: 2, verified: 1, confidence: "medium" });
    expect(r?.provenance).toMatch(/n=2 runs, 1 verified/);
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    expect(args).toEqual(["ledger", "query", "--structure-hash", "abc", "--n", "100", "--t", "100"]);
  });

  it("returns undefined on nonzero exit", () => {
    process.env.AMICO_BIN = fakeBin(dir, "amico-query-fail", `process.exit(64)`);
    expect(queryLedger("abc", 100, 100)).toBeUndefined();
  });

  it("returns undefined on unparseable / shape-mismatched stdout", () => {
    process.env.AMICO_BIN = fakeBin(dir, "amico-query-badjson", `console.log("not json")`);
    expect(queryLedger("abc", 100, 100)).toBeUndefined();
  });
});

describe("resolveWorkspaceSpecContext / stampStructureHash", () => {
  let problemsRoot: string;
  let homeRoot: string;
  const prevProblems = process.env.AMICODE_PROBLEMS_DIR;
  const prevHome = process.env.HOME;
  beforeEach(() => {
    problemsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-client-problems-"));
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-client-home-"));
    process.env.AMICODE_PROBLEMS_DIR = problemsRoot;
    process.env.HOME = homeRoot;
  });
  afterEach(() => {
    fs.rmSync(problemsRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
    if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
    else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  function stageWorkspaceWithRun(slug: string, lab: string, runId: string): void {
    const wsDir = path.join(problemsRoot, slug);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(wsDir + "/runs.json", JSON.stringify({ runs: [{ run_id: runId, lab, recorded: "t" }] }));
    const runDir = path.join(homeRoot, ".amico", "runs", lab, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "result.toml"),
      'schema_version = "1"\nfidelity = 0.999\niterations = 10\n\n[params]\nstructure_hash = "sh-1"\nproblem_hash = "ph-1"\nN = 100\nT = 100.0\n',
    );
  }

  it("resolves structure_hash + N/T from the most recent run's result.toml", () => {
    stageWorkspaceWithRun("cz-transmon", "default", "r1");
    const ctx = resolveWorkspaceSpecContext("cz-transmon");
    expect(ctx).toEqual({ structure_hash: "sh-1", N: 100, T: 100 });
    expect(stampStructureHash("cz-transmon")).toBe("sh-1");
  });

  it("returns undefined for a workspace with no runs yet", () => {
    fs.mkdirSync(path.join(problemsRoot, "fresh-problem"), { recursive: true });
    expect(resolveWorkspaceSpecContext("fresh-problem")).toBeUndefined();
    expect(stampStructureHash("fresh-problem")).toBeUndefined();
  });

  it("returns undefined when the run's result.toml has no structure_hash (pre-Task-5 runner)", () => {
    const wsDir = path.join(problemsRoot, "legacy-run");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(wsDir + "/runs.json", JSON.stringify({ runs: [{ run_id: "r2", lab: "default", recorded: "t" }] }));
    const runDir = path.join(homeRoot, ".amico", "runs", "default", "r2");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.toml"), 'schema_version = "1"\nfidelity = 0.999\niterations = 10\n');
    expect(resolveWorkspaceSpecContext("legacy-run")).toBeUndefined();
  });

  it("falls back to the run's solvespec (problem.toml) for N/T when result.toml doesn't carry them — the real Task-5 data flow", () => {
    const slug = "cz-no-nt-in-result";
    const wsDir = path.join(problemsRoot, slug);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(wsDir + "/runs.json", JSON.stringify({ runs: [{ run_id: "r3", lab: "default", recorded: "t" }] }));
    const runDir = path.join(homeRoot, ".amico", "runs", "default", "r3");
    fs.mkdirSync(runDir, { recursive: true });
    // result.toml carries ONLY structure_hash/problem_hash (as Task 5's real
    // derivation leaves it) — no N/T.
    fs.writeFileSync(
      path.join(runDir, "result.toml"),
      'schema_version = "1"\nfidelity = 0.999\niterations = 10\n\n[params]\nstructure_hash = "sh-2"\nproblem_hash = "ph-2"\n',
    );
    fs.writeFileSync(path.join(runDir, "problem.toml"), 'kind = "control"\n\n[system]\nkind = "template"\ntemplate = "TransmonSystem"\n\n[problem]\nN = 200\n\n[pulse]\nT = 50.0\n');
    fs.writeFileSync(
      path.join(runDir, "run.toml"),
      `schema_version = "1"\nrun_id = "r3"\nscript_path = ${JSON.stringify(path.join(runDir, "problem.toml"))}\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-07-22T00:00:00Z"\norchestrator_version = "0.1.0"\n\n[julia]\nbinary = "julia"\n`,
    );
    expect(resolveWorkspaceSpecContext(slug)).toEqual({ structure_hash: "sh-2", N: 200, T: 50 });
  });

  // `goal` is NEVER stamped into result.toml's [params] — settle() derives it from the
  // solvespec — so the goal key depends on this spec read happening even when N/T are
  // already known. Without it the goal key is silently inert and CZ priors leak into
  // an X-gate query (structure_hash cannot tell them apart).
  function writeRun(slug: string, runId: string, specBody: string) {
    const wsDir = path.join(problemsRoot, slug);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(wsDir + "/runs.json", JSON.stringify({ runs: [{ run_id: runId, lab: "default", recorded: "t" }] }));
    const runDir = path.join(homeRoot, ".amico", "runs", "default", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "result.toml"),
      `schema_version = "1"\nfidelity = 0.999\niterations = 10\n\n[params]\nstructure_hash = "sh-g"\nproblem_hash = "ph-g"\nN = 100\nT = 100.0\n`,
    );
    fs.writeFileSync(path.join(runDir, "problem.toml"), specBody);
    fs.writeFileSync(
      path.join(runDir, "run.toml"),
      `schema_version = "1"\nrun_id = "${runId}"\nscript_path = ${JSON.stringify(path.join(runDir, "problem.toml"))}\nlab = "default"\nlab_id = "default"\ncreated_at = "2026-07-22T00:00:00Z"\norchestrator_version = "0.1.0"\n\n[julia]\nbinary = "julia"\n`,
    );
  }

  it("extracts goal from the solvespec's [goal].gate even when N/T are already in result.toml", () => {
    writeRun("goal-gate", "rg1", 'kind = "control"\n\n[system]\nkind = "template"\ntemplate = "TransmonSystem"\n\n[goal]\nkind = "unitary"\ngate = "CZ"\n');
    expect(resolveWorkspaceSpecContext("goal-gate")?.goal).toBe("CZ");
  });

  it("falls back to [goal].kind when the spec names no gate — mirrors settle()'s derivation", () => {
    writeRun("goal-kind", "rg2", 'kind = "control"\n\n[system]\nkind = "template"\ntemplate = "TransmonSystem"\n\n[goal]\nkind = "ket"\n');
    expect(resolveWorkspaceSpecContext("goal-kind")?.goal).toBe("ket");
  });

  it("leaves goal undefined when the spec has no [goal] block (coarse-but-honest query)", () => {
    writeRun("goal-absent", "rg3", 'kind = "control"\n\n[system]\nkind = "template"\ntemplate = "TransmonSystem"\n');
    expect(resolveWorkspaceSpecContext("goal-absent")?.goal).toBeUndefined();
  });
});

describe("selectRecommendations — interim confidence cap (spec L-A#3 / success criterion 5)", () => {
  const result: LedgerQueryResult = {
    key: "primary",
    structure_hash: "abc",
    total: 5,
    verified: 5,
    params: {
      Q: { value: 150_000, iqr: [100_000, 200_000], n: 5 },
      integrator: { value: "magnus_adapt4", n: 4, total: 5 },
    },
    provenance: "n=5 runs, 5 verified (primary key)",
    confidence: "high",
  };

  it("clamps a ledger-sourced `high` confidence to `medium` — veloce auto-accepts only `high`", () => {
    const recs = selectRecommendations(result, ["Q"]);
    expect(recs).toEqual([{ param: "Q", value: 150_000, provenance: result.provenance, confidence: "medium" }]);
  });

  it("selects every matched param when none are requested", () => {
    const recs = selectRecommendations(result);
    expect(recs.map((r) => r.param).sort()).toEqual(["Q", "integrator"]);
    expect(recs.every((r) => r.confidence === "medium")).toBe(true);
  });

  it("silently drops params the ledger has no stat for (never invents a value)", () => {
    const recs = selectRecommendations(result, ["Q", "du_bound"]);
    expect(recs).toHaveLength(1);
    expect(recs[0].param).toBe("Q");
  });

  it("passes medium/low confidence through unclamped", () => {
    const medium = selectRecommendations({ ...result, confidence: "medium" }, ["Q"]);
    expect(medium[0].confidence).toBe("medium");
    const low = selectRecommendations({ ...result, confidence: "low" }, ["Q"]);
    expect(low[0].confidence).toBe("low");
  });
});

// ── Task 7: extension-side stanza builders (pure — I/O-free) ─────────────────
describe("attemptErrorStanza", () => {
  it("carries the field-path errors, stamps ts, and omits session when absent", () => {
    const rec = attemptErrorStanza([{ path: "problem.Q", msg: "must be number" }]);
    expect(rec.type).toBe("attempt_error");
    expect(rec.errors).toEqual([{ path: "problem.Q", msg: "must be number" }]);
    expect(rec.session).toBeUndefined();
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
  });
  it("includes session when given", () => {
    expect(attemptErrorStanza([], "s1").session).toBe("s1");
  });
});

describe("fallbackStanza", () => {
  it("carries from_tier + reason", () => {
    const rec = fallbackStanza("composed", "script no longer matches the exemplar's physics");
    expect(rec).toMatchObject({
      type: "fallback",
      from_tier: "composed",
      reason: "script no longer matches the exemplar's physics",
    });
  });
});

describe("verdictStanza", () => {
  it("maps agree/disagree + both fidelities, structure_hash optional", () => {
    const rec = verdictStanza({
      problemHash: "ph-1",
      structureHash: "sh-1",
      verdict: "agree",
      fidelityRerolled: 0.9993,
      fidelityReported: 0.9994,
    });
    expect(rec).toMatchObject({
      type: "verdict",
      problem_hash: "ph-1",
      structure_hash: "sh-1",
      verdict: "agree",
      fidelity_rerolled: 0.9993,
      fidelity_reported: 0.9994,
    });
  });
  it("omits structure_hash/fidelities when not given", () => {
    const rec = verdictStanza({ problemHash: "ph-2", verdict: "disagree" });
    expect(rec.structure_hash).toBeUndefined();
    expect(rec.fidelity_rerolled).toBeUndefined();
    expect(rec.fidelity_reported).toBeUndefined();
    expect(rec.verdict).toBe("disagree");
  });
});

describe("resolveRunHashes", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-client-rundir-"));
  });
  afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

  it("reads structure_hash/problem_hash from result.toml [params]", () => {
    fs.writeFileSync(
      path.join(runDir, "result.toml"),
      'schema_version = "1"\nfidelity = 0.999\niterations = 5\n\n[params]\nstructure_hash = "sh-9"\nproblem_hash = "ph-9"\n',
    );
    expect(resolveRunHashes(runDir)).toEqual({ structure_hash: "sh-9", problem_hash: "ph-9" });
  });

  it("returns undefined when result.toml is absent or has neither hash", () => {
    expect(resolveRunHashes(runDir)).toBeUndefined();
    fs.writeFileSync(path.join(runDir, "result.toml"), 'schema_version = "1"\nfidelity = 0.999\niterations = 5\n');
    expect(resolveRunHashes(runDir)).toBeUndefined();
  });
});
