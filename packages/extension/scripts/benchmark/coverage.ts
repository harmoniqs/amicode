// STAGE (v2): tool-coverage report — "codecov for agents". Pure fn of the
// transcripts stage 1 already wrote; no new capture, no Bedrock spend.
import * as fs from "node:fs";
import * as path from "node:path";
import { BENCH_DIR } from "./config";

/** config.ts exports BENCH_DIR (the benchmark dir), not the out dir — derive it
 *  here exactly as driver.ts/scorer.ts do (path.join(BENCH_DIR, "out")). */
const OUT_DIR = path.join(BENCH_DIR, "out");

/** The amicode tool surface — the coverage denominator. Keep in sync with
 *  opencode-plugin/amicode_tools.ts (12 tools). */
export const ALL_TOOLS = [
  "amicode_ask", "amicode_calibrate", "amicode_formulate", "amicode_pick_system",
  "amicode_problem", "amicode_profile", "amicode_recommend", "amicode_set_model",
  "amicode_solve", "amicode_to_hardware", "amicode_veloce", "amicode_verify",
] as const;

export interface ModelCoverage {
  toolsHit: string[];
  hitCount: number;
  total: number;
  /** stage name → max iterationIndex observed (recovery depth). */
  maxIteration: Record<string, number>;
}

type Line = Record<string, unknown>;

/** input: model → array of transcripts, each transcript an array of JSONL records. */
export function computeCoverage(byModel: Record<string, Line[][]>): Record<string, ModelCoverage> {
  const out: Record<string, ModelCoverage> = {};
  const toolSet = new Set<string>(ALL_TOOLS);
  for (const [model, transcripts] of Object.entries(byModel)) {
    const hit = new Set<string>();
    const maxIter: Record<string, number> = {};
    for (const tr of transcripts) {
      for (const rec of tr) {
        if (rec.kind === "turn") {
          for (const c of (rec.toolCalls as Array<{ tool?: string }>) ?? [])
            if (c.tool && toolSet.has(c.tool)) hit.add(c.tool);
          const stage = rec.stage as string | undefined;
          const it = rec.iterationIndex as number | undefined;
          if (stage !== undefined && typeof it === "number")
            maxIter[stage] = Math.max(maxIter[stage] ?? 0, it);
        }
      }
    }
    out[model] = {
      toolsHit: [...hit],
      hitCount: hit.size,
      total: ALL_TOOLS.length,
      maxIteration: maxIter,
    };
  }
  return out;
}

/** Read all transcripts under outDir, grouped by model. */
export function loadTranscriptsByModel(outDir = OUT_DIR): Record<string, Line[][]> {
  const byModel: Record<string, Line[][]> = {};
  for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith(".jsonl"))) {
    const model = f.split("__")[0];
    const lines = fs
      .readFileSync(path.join(outDir, f), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
    (byModel[model] ??= []).push(lines);
  }
  return byModel;
}

/** Render out/coverage.md — per-model tools-hit/12 + the hit matrix + iteration depth. */
export function renderCoverage(cov: Record<string, ModelCoverage>): string {
  const models = Object.keys(cov).sort();
  let md = "# Amicode agent tool-coverage report\n\n";
  md += "Tool coverage = distinct `amicode_*` tools the model invoked across its scenarios, out of 12.\n\n";
  md += "| Model | coverage | tools hit |\n|---|---:|---|\n";
  for (const m of models) {
    const c = cov[m];
    md += `| \`${m}\` | ${c.hitCount}/${c.total} | ${c.toolsHit.map((t) => t.replace("amicode_", "")).sort().join(", ")} |\n`;
  }
  // Union / never-hit across the whole cohort.
  const union = new Set<string>();
  for (const m of models) cov[m].toolsHit.forEach((t) => union.add(t));
  const neverHit = ALL_TOOLS.filter((t) => !union.has(t));
  md += `\n**Cohort union:** ${union.size}/${ALL_TOOLS.length} tools reached by at least one model.\n`;
  md += neverHit.length
    ? `\n**Never hit by any model (scenario gap):** ${neverHit.map((t) => "`" + t + "`").join(", ")}\n`
    : `\n**Every tool was reached by at least one model.** ✅\n`;
  return md;
}

// Cast form required — bare `import.meta.main` fails tsc (ES2022 lib) in this
// repo; driver.ts:449 + scorer.ts:226 use exactly this cast.
if ((import.meta as unknown as { main?: boolean }).main) {
  const cov = computeCoverage(loadTranscriptsByModel());
  const md = renderCoverage(cov);
  const outPath = path.join(OUT_DIR, "coverage.md");
  fs.writeFileSync(outPath, md);
  console.log(md);
  console.log(`\nwrote ${outPath}`);
}
