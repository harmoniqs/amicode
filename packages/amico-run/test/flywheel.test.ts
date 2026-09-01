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
import { cpSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FLYWHEEL_FIXTURES = join(PKG_ROOT, "fixtures", "flywheel");
export const RUNS_FIXTURE = join(FLYWHEEL_FIXTURES, "runs");
export const TASKS_FIXTURE = join(FLYWHEEL_FIXTURES, "tasks");
export const STORE_FIXTURE = join(FLYWHEEL_FIXTURES, "store");
export const BRIDGE_FIXTURES = join(PKG_ROOT, "fixtures", "bridge");

import { deriveRunDirFamily } from "../src/flywheel.js";

describe("SEAM 7 derivation (a) — run dir → campaign family", () => {
  it("a plain fixed-time gate-synthesis run (TransmonSystem + unitary CZ) is first-pulse", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260801-010000Z-fa01"));
    expect(r.kind).toBe("run-dir");
    if (r.kind !== "run-dir") return;
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
    if (r?.kind !== "run-dir") return;
    expect(r.family).toBe("regime-sweep");
    expect(r.metrics.iterations).toBe(50);
  });

  it("a run with a sensitivity objective term is robustness (the hardening family)", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260803-010100Z-fc02"));
    expect(r?.kind).toBe("run-dir");
    if (r?.kind !== "run-dir") return;
    expect(r.family).toBe("robustness");
    expect(r.metrics.iterations).toBe(55);
  });

  it("a state-prep run (goal.kind ket) maps honestly to first-pulse — a one-shot synthesis, NOT forced into sweep/robustness", () => {
    const r = deriveRunDirFamily(join(RUNS_FIXTURE, "lab-fx", "r20260803-010200Z-fc03"));
    expect(r?.kind).toBe("run-dir");
    if (r?.kind !== "run-dir") return;
    expect(r.family).toBe("first-pulse");
    expect(r.goal_kind).toBe("ket");
    expect(r.target).toBe("cat_alpha2"); // [goal].target (the ket axis of the target field)
  });

  it("a pre-v4 run dir (authored-script shape, like the SEAM 4 bridge fixture) is unattributable — listed, never forced (F-709-5)", () => {
    const r = deriveRunDirFamily(join(BRIDGE_FIXTURES, "amicode-run"));
    expect(r?.kind).toBe("run-dir-unattributable");
    if (r?.kind !== "run-dir-unattributable") return;
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
    if (r?.kind !== "run-dir") return;
    expect(r.metrics.iterations).toBe(60);
    expect(r.metrics.wall_s).toBe(200); // 02:03:20 − 02:00:00
    expect(r.metrics.wall_source).toBe("finished-mtime");
  });
});
