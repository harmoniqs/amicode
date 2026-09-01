// flywheel.test.ts — SEAM 7 (#709): the campaign-family derivation + the decay
// computation. Unit tests over COMMITTED canonical fixtures (fixtures/flywheel/)
// plus the SEAM 4 bridge fixtures where the shapes match (the strumento task
// record; the pre-v4 authored-script run dir). The real-store proof is the
// env-gated slow test (test/slow/flywheel_real.test.ts — the director runs it
// against the real backlog).
//
// The family taxonomy is the repertoire's eight (first pulse, regime sweep,
// robustness, bring-up, tune-up, drift response, team ops, night runs); each
// record kind maps onto it via a NAMED MECHANICAL DERIVATION — never a
// pre-existing tag, never new stamping. The exact fields each derivation reads
// and the family mapping are the doc of record: docs/flywheel-decay.md.
import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FLYWHEEL_FIXTURES = join(PKG_ROOT, "fixtures", "flywheel");
export const RUNS_FIXTURE = join(FLYWHEEL_FIXTURES, "runs");
export const TASKS_FIXTURE = join(FLYWHEEL_FIXTURES, "tasks");
export const STORE_FIXTURE = join(FLYWHEEL_FIXTURES, "store");
export const BRIDGE_FIXTURES = join(PKG_ROOT, "fixtures", "bridge");

import { deriveRunDirFamily, deriveTaskRecordFamily, deriveStoreEntryFamily, computeDecay } from "../src/flywheel.js";

/** Copy the committed runs fixture to tmp with the FINISHED mtime of the
 *  no-wall_seconds run pinned (fa02 → created+200s), so the mtime-fallback
 *  campaign math is deterministic — committed fixture bytes are never touched
 *  and a checkout's clone-time mtimes never leak into an assertion. */
function pinnedRunsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-runs-"));
  cpSync(RUNS_FIXTURE, root, { recursive: true });
  utimesSync(
    join(root, "lab-fx", "r20260801-020000Z-fa02", "FINISHED"),
    new Date("2026-08-01T02:03:20Z"),
    new Date("2026-08-01T02:03:20Z"),
  );
  return root;
}

describe("SEAM 7 derivation (a) — run dir → campaign family", () => {
  it("a plain fixed-time gate-synthesis run (TransmonSystem + unitary CZ) is first-pulse", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260801-010000Z-fa01"));
    expect(r?.kind).toBe("run-dir");
    if (!r || r.kind !== "run-dir") return;
    expect(r.family).toBe("first-pulse");
    // the EXACT fields the derivation reads (grep-pinned in docs/flywheel-decay.md)
    expect(r.platform).toBe("transmon"); // problem.toml [system].template → platform family
    expect(r.goal_kind).toBe("unitary"); // problem.toml [goal].kind
    expect(r.target).toBe("CZ"); // problem.toml [goal].gate
    expect(r.workspace).toBe("lab-fx"); // run.toml lab_id
    expect(r.day).toBe("2026-08-01"); // run.toml created_at (UTC day)
    expect(r.metrics.iterations).toBe(40); // result.toml iterations
    expect(r.metrics.wall_s).toBe(100); // result.toml wall_seconds (record-carried)
    expect(r.metrics.wall_source).toBe("record");
  });

  it("a min-time run (problem.free_dt ≠ false — Piccolo's min-time marker) is regime-sweep", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260803-010000Z-fc01"));
    expect(r?.kind).toBe("run-dir");
    if (!r || r.kind !== "run-dir") return;
    expect(r.family).toBe("regime-sweep");
    expect(r.metrics.iterations).toBe(50);
  });

  it("a run with a sensitivity objective term is robustness (the hardening family)", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260803-010100Z-fc02"));
    expect(r?.kind).toBe("run-dir");
    if (!r || r.kind !== "run-dir") return;
    expect(r.family).toBe("robustness");
    expect(r.metrics.iterations).toBe(55);
  });

  it("a state-prep run (goal.kind ket) maps honestly to first-pulse — a one-shot synthesis, NOT forced into sweep/robustness", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260803-010200Z-fc03"));
    expect(r?.kind).toBe("run-dir");
    if (!r || r.kind !== "run-dir") return;
    expect(r.family).toBe("first-pulse");
    expect(r.goal_kind).toBe("ket");
    expect(r.target).toBe("cat_alpha2"); // [goal].target (the ket axis of the target field)
  });

  it("a pre-v4 run dir (authored-script shape, like the SEAM 4 bridge fixture) is unattributable — listed, never forced (F-709-5)", () => {
    const r = deriveRunDirFamily(join(BRIDGE_FIXTURES, "amicode-run"));
    expect(r?.kind).toBe("run-dir-unattributable");
    if (!r || r.kind !== "run-dir-unattributable") return;
    expect(r.reason).toMatch(/F-709-5/);
  });

  it("wall clock without result.toml wall_seconds degrades to FINISHED mtime − created_at, source-labeled (F-709-1)", () => {
    // committed fixture bytes are never touched: copy to tmp and PIN the FINISHED
    // mtime (a checkout's mtime is the clone time, not the solve's end — the
    // fragility named in F-709-1 is exactly why the source label exists).
    const labFx = mkdtempSync(join(tmpdir(), "flywheel-mtime-"));
    cpSync(join(RUNS_FIXTURE, "lab-fx"), labFx, { recursive: true });
    const fa02 = join(labFx, "r20260801-020000Z-fa02");
    utimesSync(join(fa02, "FINISHED"), new Date("2026-08-01T02:03:20Z"), new Date("2026-08-01T02:03:20Z"));
    const r = deriveRunDirFamily(fa02);
    expect(r?.kind).toBe("run-dir");
    if (!r || r.kind !== "run-dir") return;
    expect(r.metrics.iterations).toBe(60);
    expect(r.metrics.wall_s).toBe(200); // 02:03:20 − 02:00:00
    expect(r.metrics.wall_source).toBe("finished-mtime");
  });
});

describe("SEAM 7 derivation (b) — task record → campaign family", () => {
  it("a bringup-kind task record is bring-up; acquisitions = the acquire-labeled progress events; wall = result.ended − task.created", () => {
    const r = deriveTaskRecordFamily(join(TASKS_FIXTURE, "2026-08-20-bringup-fx01"));
    expect(r?.kind).toBe("task-record");
    if (!r || r.kind !== "task-record") return;
    expect(r.family).toBe("bring-up"); // task.toml kind axis
    expect(r.device).toBe("qick-fx-01"); // task.toml device (the device key)
    expect(r.day).toBe("2026-08-20"); // task.toml created (UTC day)
    expect(r.metrics.acquisitions).toBe(2); // progress.jsonl ev=progress label=acquire count
    expect(r.metrics.iterations).toBeUndefined(); // F-709-4: prose-only on task records
    expect(r.metrics.wall_s).toBe(600); // 10:10:00 − 10:00:00 (record-carried both ends)
    expect(r.metrics.wall_source).toBe("record");
  });

  it("an experiment-kind task record is the closed-loop tune-up family — the SEAM 4 strumento fixture reused as the canonical shape", () => {
    const r = deriveTaskRecordFamily(join(BRIDGE_FIXTURES, "2026-08-31-strumento-task-b3a7"));
    expect(r?.kind).toBe("task-record");
    if (!r || r.kind !== "task-record") return;
    expect(r.family).toBe("tune-up"); // journey §5: pre-P4 this stage delivers the sim rehearsal
    expect(r.device).toBe("loopback_demo");
    expect(r.metrics.acquisitions).toBe(1);
    expect(r.metrics.wall_s).toBe(90); // 12:01:30 − 12:00:00
  });

  it("an unknown kind axis value is honestly skipped — listed unattributed, never forced (the forward-compat axis)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-task-"));
    cpSync(join(TASKS_FIXTURE, "2026-08-20-bringup-fx01"), join(dir, "2026-08-22-unknown-fx03"), { recursive: true });
    const manifest = join(dir, "2026-08-22-unknown-fx03", "task.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace('kind = "bringup"', 'kind = "monitor"').replace('id = "2026-08-20-bringup-fx01"', 'id = "2026-08-22-unknown-fx03"'));
    const r = deriveTaskRecordFamily(join(dir, "2026-08-22-unknown-fx03"));
    expect(r?.kind).toBe("task-record-unattributable");
    if (!r || r.kind !== "task-record-unattributable") return;
    expect(r.reason).toMatch(/kind/);
  });
});

describe("SEAM 7 derivation (c) — store provenance → campaign family (the source stamp)", () => {
  it("a plain banked entry (no lineage) is first-pulse — the day-one campaign's terminal artifact", () => {
    const r = deriveStoreEntryFamily(join(STORE_FIXTURE, "pulses", "transmon-CZ-v1"));
    expect(r?.kind).toBe("store-entry");
    if (!r || r.kind !== "store-entry") return;
    expect(r.family).toBe("first-pulse");
    expect(r.id).toBe("transmon-CZ-v1");
    expect(r.platform).toBe("transmon"); // metadata.toml platform
    expect(r.day).toBe("2026-08-01"); // metadata.toml date
    expect(r.lineage.warm_start).toBeUndefined();
    expect(r.lineage.calibration_ref).toBeUndefined();
  });

  it("a warm_start chain entry is tune-up — the closed-loop family's warm-started refinement (most specific stamp present wins)", () => {
    const r = deriveStoreEntryFamily(join(STORE_FIXTURE, "pulses", "transmon-CZ-v2"));
    expect(r?.kind).toBe("store-entry");
    if (!r || r.kind !== "store-entry") return;
    expect(r.family).toBe("tune-up");
    expect(r.lineage.warm_start).toBe("transmon-CZ-v1");
  });

  it("a calibration_ref entry is drift-response — the SEAM 5 drift-response tune-up chain's re-bank", () => {
    const r = deriveStoreEntryFamily(join(STORE_FIXTURE, "pulses", "transmon-CZ-v3"));
    expect(r?.kind).toBe("store-entry");
    if (!r || r.kind !== "store-entry") return;
    expect(r.family).toBe("drift-response");
    expect(r.lineage.calibration_ref).toContain("rehearsal.toml");
    expect(r.lineage.warm_start).toBe("transmon-CZ-v2"); // the seed still carried
  });
});

describe("SEAM 7 — the decay computation (campaign grouping + the trend)", () => {
  it("groups same-family run dirs into per-day campaigns and computes the trend vs the PRIOR campaign", () => {
    const report = computeDecay({ runsRoots: [pinnedRunsFixture()] });
    const fp = report.families.find((f) => f.family === "first-pulse");
    expect(fp).toBeDefined();
    const series = fp!.scopes.find((s) => s.record_kind === "run-dir");
    expect(series).toBeDefined();
    expect(series!.scope).toBe("sim:lab-fx/transmon"); // sim families key workspace + platform
    expect(series!.scope_kind).toBe("sim");
    expect(series!.campaigns.map((c) => c.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    // day 1: fa01 (iters 40, wall 100 record) + fa02 (iters 60, wall 200 mtime)
    const d1 = series!.campaigns[0];
    expect(d1.records).toBe(2);
    expect(d1.iterations).toBe(100);
    expect(d1.wall_s).toBe(300);
    expect(d1.wall_source).toBe("mixed"); // one record-carried + one fs-mtime fallback
    expect(d1.acquisitions).toBeNull(); // F-709-3: run dirs carry no acquisitions
    expect(d1.metrics_absent.join(" ")).toMatch(/F-709-3/);
    expect(d1.decay).toBe("baseline"); // the FIRST campaign has no decay — stated, not zero-division
    expect(d1.deltas).toBeNull();
    // day 2 vs day 1: the three metrics' deltas (acquisitions stated-absent)
    const d2 = series!.campaigns[1];
    expect(d2.decay).toBe("trend");
    expect(d2.deltas!.iterations).toBe(30 - 100);
    expect(d2.deltas!.wall_s).toBe(50 - 300);
    expect(d2.deltas!.iterations_pct).toBeCloseTo(-70, 6);
    expect(d2.deltas!.acquisitions).toBeNull();
    // day 3 (the ket run — same family, one-shot synthesis) vs day 2
    const d3 = series!.campaigns[2];
    expect(d3.records).toBe(1);
    expect(d3.deltas!.iterations).toBe(70 - 30);
  });

  it("a family with a single campaign is a stated baseline — no delta is faked", () => {
    const report = computeDecay({ runsRoots: [pinnedRunsFixture()] });
    const sweep = report.families.find((f) => f.family === "regime-sweep");
    expect(sweep!.scopes[0].campaigns).toHaveLength(1);
    expect(sweep!.scopes[0].campaigns[0].decay).toBe("baseline");
    const robust = report.families.find((f) => f.family === "robustness");
    expect(robust!.scopes[0].campaigns).toHaveLength(1);
    expect(robust!.scopes[0].campaigns[0].decay).toBe("baseline");
  });

  it("task records form device-keyed campaigns: bring-up day 2 is cheaper than day 1 (acquisitions, wall clock)", () => {
    const report = computeDecay({ taskRoots: [TASKS_FIXTURE, BRIDGE_FIXTURES] });
    const bringup = report.families.find((f) => f.family === "bring-up");
    expect(bringup).toBeDefined();
    const series = bringup!.scopes.find((s) => s.record_kind === "task-record");
    expect(series!.scope).toBe("device:qick-fx-01"); // device-touching families key on the device
    expect(series!.scope_kind).toBe("device");
    const [d1, d2] = series!.campaigns;
    expect(d1.acquisitions).toBe(2);
    expect(d1.wall_s).toBe(600);
    expect(d1.iterations).toBeNull(); // F-709-4: prose-only on task records
    expect(d1.metrics_absent.join(" ")).toMatch(/F-709-4/);
    expect(d2.deltas!.acquisitions).toBe(1 - 2);
    expect(d2.deltas!.wall_s).toBe(240 - 600);
    expect(d2.deltas!.iterations).toBeNull();
    // the SEAM 4 strumento fixture rode along as the tune-up family (the sim rehearsal)
    const tuneup = report.families.find((f) => f.family === "tune-up");
    expect(tuneup!.scopes[0].scope).toBe("device:loopback_demo");
    expect(tuneup!.scopes[0].campaigns[0].acquisitions).toBe(1);
  });

  it("store entries count campaigns per family; their cost metrics are stated-absent (the bank carries lineage, not cost)", () => {
    const report = computeDecay({ storeRoots: [STORE_FIXTURE] });
    const fp = report.families.find((f) => f.family === "first-pulse");
    const series = fp!.scopes.find((s) => s.record_kind === "store-entry");
    expect(series!.scope).toBe("bank:transmon");
    expect(series!.campaigns[0].records).toBe(1);
    expect(series!.campaigns[0].acquisitions).toBeNull();
    expect(series!.campaigns[0].iterations).toBeNull();
    expect(series!.campaigns[0].wall_s).toBeNull();
    expect(series!.campaigns[0].decay).toBe("baseline");
    // tune-up + drift-response entries are device-touching families with NO
    // device field in metadata.toml — they degrade per F-709-2 and still compute
    const tuneup = report.families.find((f) => f.family === "tune-up");
    expect(tuneup!.scopes[0].scope).toBe("bank:transmon");
    const drift = report.families.find((f) => f.family === "drift-response");
    expect(drift!.scopes[0].campaigns).toHaveLength(1);
    expect(report.findings.join(" ")).toMatch(/F-709-2/);
  });

  it("a sim-only family with no device field anywhere computes — never vacuously fails (the spec's scoping)", () => {
    const report = computeDecay({ runsRoots: [pinnedRunsFixture()] });
    expect(report.families.length).toBeGreaterThan(0);
    const fp = report.families.find((f) => f.family === "first-pulse")!;
    expect(fp.scopes.every((s) => s.scope_kind === "sim")).toBe(true);
  });

  it("pre-v4 and unknown-kind records are listed unattributed, never forced", () => {
    const report = computeDecay({
      runsRoots: [BRIDGE_FIXTURES], // the amicode-run bridge fixture (pre-v4 shape)
      taskRoots: [TASKS_FIXTURE],
    });
    expect(report.unattributed.length).toBeGreaterThan(0);
    expect(report.unattributed.every((u) => u.reason.length > 0)).toBe(true);
  });
});

describe("SEAM 7 doc of record — the derivation is grep-pinned, not vibes (flywheel_derivation_specified_per_record_kind == 3)", () => {
  const REPO_ROOT = join(PKG_ROOT, "..", "..");
  const NOTE = join(REPO_ROOT, "docs", "flywheel-decay.md");
  const note = readFileSync(NOTE, "utf8");

  it("the note exists and is published in the docs contents", () => {
    expect(note.length).toBeGreaterThan(0);
    const readme = readFileSync(join(REPO_ROOT, "docs", "README.md"), "utf8");
    expect(readme).toContain("flywheel-decay.md");
  });

  it("THREE named derivations, each documented with the EXACT fields it reads", () => {
    expect(note).toMatch(/Derivation \(a\) — run dir/);
    expect(note).toMatch(/Derivation \(b\) — task record/);
    expect(note).toMatch(/Derivation \(c\) — store provenance/);
    // derivation (a): the exact run-dir fields
    for (const field of ["[system].template", "[goal].kind", "[goal].gate", "[problem].free_dt", "lab_id", "created_at", "iterations", "wall_seconds"]) {
      expect(note).toContain(field);
    }
    // derivation (b): the exact task-record fields
    for (const field of ["`kind`", "`device`", "`created`", "`ended`", '"acquire"']) {
      expect(note).toContain(field);
    }
    // derivation (c): the exact store fields
    for (const field of ["`warm_start`", "`calibration_ref`", "`date`", "`platform`"]) {
      expect(note).toContain(field);
    }
  });

  it("the family mapping is stated per family — all eight, with the underivable two honestly named", () => {
    for (const family of ["first-pulse", "regime-sweep", "robustness", "bring-up", "tune-up", "drift-response", "team-ops", "night-runs"]) {
      expect(note).toContain(family);
    }
    expect(note).toMatch(/NOT derivable from existing records/); // team-ops/night-runs honesty
  });

  it("the decay formulas are stated (Σ per campaign, delta vs prior, baseline not zero)", () => {
    expect(note).toMatch(/first campaign of a series is the baseline/);
    expect(note).toMatch(/absent ≠ 0/);
    expect(note).toMatch(/zero-division/);
  });

  it("every F4 finding is named in the note (the findings the director files)", () => {
    for (const id of ["F-709-1", "F-709-2", "F-709-3", "F-709-4", "F-709-5", "F-709-6"]) {
      expect(note).toContain(id);
    }
    // the emitted findings and the note's IDs agree (no silent divergence)
    for (const id of ["F-709-1", "F-709-2", "F-709-3", "F-709-4", "F-709-5", "F-709-6"]) {
      expect(computeDecay({}).findings.join(" ")).toContain(id);
    }
  });

  it("the device-key scoping is stated (device-touching families vs workspace+platform)", () => {
    expect(note).toMatch(/device-touching families \(bring-up, tune-up, drift-response\) → \*\*device\*\*/);
    expect(note).toMatch(/sim families \(first-pulse, regime-sweep, robustness\) → \*\*workspace \+ platform\*\*/);
    expect(note).toMatch(/a sim-only family with no device field must compute, never vacuously fail/);
  });
});
