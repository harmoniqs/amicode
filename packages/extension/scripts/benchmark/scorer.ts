// ============================================================================
// STAGE 3 — scorer.ts
//
// Reads the driver's JSONL transcripts (out/*.jsonl), scores each cell on the 4
// axes (rubric.ts), and writes ONE scores JSON per cell to out/scores/. A PURE
// function of the transcripts + the fixed rubric — re-runnable without touching
// the driver. The LLM-judge axis calls the fixed judge model (models.toml).
//
// The cost axis is COHORT-RELATIVE: it needs all cells' cost/latency to
// normalize, so the cost sub-score is computed here across the whole batch after
// the per-cell programmatic + judge scores are in.
//
// USAGE:
//   bun scripts/benchmark/scorer.ts [--out DIR] [--no-judge]
//     --no-judge : skip the LLM axis (programmatic-only; fast, offline-ish).
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModels, BENCH_DIR } from "./config";
import {
  runProgrammaticChecks,
  buildJudgePrompt,
  callJudge,
  AXIS_WEIGHTS,
  type Axis,
  type JudgeScores,
  type ProgrammaticResult,
} from "./rubric";
import type { TranscriptRecord, MetaRecord, TurnRecord, DoneRecord, ErrorRecord } from "./types";

export interface CellScore {
  model: string;
  scenario: string;
  run: number;
  excludeFromHeadline: boolean;
  /** null when the cell errored/crashed before producing usable turns. */
  axes: Record<Axis, number> | null;
  weighted: number | null;
  /** raw signals for the report + audit. */
  programmatic: ProgrammaticResult;
  judge: JudgeScores | null;
  cost: { totalCost: number; totalWallMs: number; turns: number };
  crashed: boolean;
  crashPhase?: string;
  notes: string[];
}

function readTranscript(file: string): TranscriptRecord[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptRecord);
}

/** Blend programmatic sub-rates into a protocol/completion/robustness base
 *  (0..1), later averaged with the judge's take. */
function programmaticAxes(p: ProgrammaticResult): { protocol: number; completion: number; robustness: number } {
  // protocol: cadence (avoid stage-batching = avoidRate) + legal tool use (toolAvoidRate)
  const protocol = mean([p.avoidRate, p.toolAvoidRate]);
  // completion: hit expected content + expected tools
  const completion = mean([p.matchRate, p.toolHitRate]);
  // robustness: no forbidden tools + no opencode errors
  const robustness = mean([p.toolAvoidRate, p.hadError ? 0 : 1]);
  return { protocol, completion, robustness };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Score a single cell (everything except the cohort-relative cost axis). */
async function scoreCell(file: string, judgeModel: string, useJudge: boolean): Promise<CellScore> {
  const records = readTranscript(file);
  const meta = records.find((r): r is MetaRecord => r.kind === "meta");
  const done = records.find((r): r is DoneRecord => r.kind === "done");
  const err = records.find((r): r is ErrorRecord => r.kind === "error");
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");

  // A cell that never produced a meta/turn (boot failure) is a crash: no axes.
  const bootFailed = !meta || turns.length === 0;
  const programmatic = runProgrammaticChecks(records);
  const notes = [...programmatic.turnNotes];

  const cost = {
    totalCost: done?.totalCost ?? turns.reduce((s, t) => s + t.usage.cost, 0),
    totalWallMs: done?.totalWallMs ?? turns.reduce((s, t) => s + t.wallMs, 0),
    turns: turns.length,
  };

  if (bootFailed) {
    return {
      model: meta?.model ?? modelFromFilename(file),
      scenario: meta?.scenario ?? scenarioFromFilename(file),
      run: meta?.run ?? runFromFilename(file),
      excludeFromHeadline: meta?.scenario_meta.exclude_from_headline ?? false,
      axes: null,
      weighted: null,
      programmatic,
      judge: null,
      cost,
      crashed: true,
      crashPhase: err?.phase ?? "boot",
      notes: [`crashed: ${err?.message ?? "no transcript"}`, ...notes],
    };
  }

  const base = programmaticAxes(programmatic);
  let judge: JudgeScores | null = null;
  if (useJudge) {
    try {
      judge = await callJudge(judgeModel, buildJudgePrompt(records));
    } catch (e) {
      notes.push(`judge failed (programmatic-only for this cell): ${String((e as Error).message).slice(0, 160)}`);
    }
  }

  // Blend: average programmatic base with judge where the judge ran.
  const blend = (progVal: number, judgeVal: number | undefined): number =>
    judgeVal === undefined ? progVal : mean([progVal, judgeVal]);
  const axes: Record<Axis, number> = {
    protocol: blend(base.protocol, judge?.protocol),
    completion: blend(base.completion, judge?.completion),
    robustness: blend(base.robustness, judge?.robustness),
    // cost is filled cohort-relative in a second pass; placeholder here.
    cost: 0,
  };

  return {
    model: meta.model,
    scenario: meta.scenario,
    run: meta.run,
    excludeFromHeadline: meta.scenario_meta.exclude_from_headline ?? false,
    axes,
    weighted: null, // filled after cost normalization
    programmatic,
    judge,
    cost,
    crashed: !!err,
    crashPhase: err?.phase,
    notes,
  };
}

/** Cohort-relative cost axis: cheapest+fastest cell → 1.0, most expensive → ~0.
 *  Uses a blend of normalized $ cost and wall-clock across all NON-crashed cells.
 *  Then computes the weighted head-to-head score. Mutates in place. */
function fillCostAxisAndWeighted(cells: CellScore[]): void {
  const live = cells.filter((c) => c.axes && !c.crashed && c.cost.turns > 0);
  const costs = live.map((c) => c.cost.totalCost);
  const walls = live.map((c) => c.cost.totalWallMs);
  const maxCost = Math.max(...costs, 1e-9);
  const minCost = Math.min(...costs, 0);
  const maxWall = Math.max(...walls, 1);
  const minWall = Math.min(...walls, 0);
  const norm = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);
  for (const c of cells) {
    if (!c.axes) continue;
    // invert: lower cost/wall → higher score. Weight $ and latency evenly.
    const costScore = 1 - norm(c.cost.totalCost, minCost, maxCost);
    const wallScore = 1 - norm(c.cost.totalWallMs, minWall, maxWall);
    c.axes.cost = mean([costScore, wallScore]);
    c.weighted =
      (Object.keys(AXIS_WEIGHTS) as Axis[]).reduce((s, ax) => s + AXIS_WEIGHTS[ax] * c.axes![ax], 0) /
      Object.values(AXIS_WEIGHTS).reduce((a, b) => a + b, 0);
  }
}

// ---- filename fallbacks (when a cell crashed before writing meta) -----------
function partsFromFilename(file: string): { model: string; scenario: string; run: number } {
  const base = path.basename(file, ".jsonl"); // model__Sx__runN
  const [model, scenario, runStr] = base.split("__");
  return { model: model ?? base, scenario: scenario ?? "?", run: Number((runStr ?? "run0").replace("run", "")) || 0 };
}
const modelFromFilename = (f: string) => partsFromFilename(f).model;
const scenarioFromFilename = (f: string) => partsFromFilename(f).scenario;
const runFromFilename = (f: string) => partsFromFilename(f).run;

// ---- main -------------------------------------------------------------------
async function main(): Promise<void> {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args.set(key, val);
    }
  }
  const cfg = loadModels();
  const outDir = args.get("out") ? path.resolve(args.get("out")!) : path.join(BENCH_DIR, "out");
  const useJudge = args.get("no-judge") !== "true";
  const scoresDir = path.join(outDir, "scores");
  fs.mkdirSync(scoresDir, { recursive: true });

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(outDir, f));
  if (files.length === 0) {
    console.error(`[scorer] no transcripts in ${outDir}; run the driver first.`);
    process.exit(1);
  }
  console.error(`[scorer] scoring ${files.length} cell(s); judge=${useJudge ? cfg.judge : "OFF"}`);

  const cells: CellScore[] = [];
  for (const f of files) {
    process.stderr.write(`[scorer] ${path.basename(f)} … `);
    const cell = await scoreCell(f, cfg.judge, useJudge);
    cells.push(cell);
    console.error(cell.crashed ? "crashed" : "ok");
  }
  fillCostAxisAndWeighted(cells);

  for (const c of cells) {
    fs.writeFileSync(
      path.join(scoresDir, `${c.model.replace(/[^a-zA-Z0-9._-]/g, "-")}__${c.scenario}__run${c.run}.json`),
      JSON.stringify(c, null, 2) + "\n",
    );
  }
  fs.writeFileSync(path.join(scoresDir, "_all.json"), JSON.stringify(cells, null, 2) + "\n");
  console.error(`[scorer] wrote ${cells.length} cell scores → ${scoresDir}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
  main().catch((e) => {
    console.error("[scorer] fatal:", e);
    process.exit(1);
  });
}

export { scoreCell, fillCostAxisAndWeighted, programmaticAxes };
