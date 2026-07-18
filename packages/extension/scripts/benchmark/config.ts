// ============================================================================
// Config loaders for the benchmark harness — models.toml + scenarios/*.toml.
// Data-only: no scoring, no opencode. Pure parse → typed structs.
// ============================================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Scenario, ScenarioTurn, TurnExpectation } from "./types";

export const BENCH_DIR = __dirname;
export const SCENARIOS_DIR = path.join(BENCH_DIR, "scenarios");

/** Absolute path to the vendored opencode binary for this platform/arch. */
export function vendoredOpencodeBin(): string {
  const ext = path.resolve(BENCH_DIR, "..", ".."); // scripts/benchmark → packages/extension
  return path.join(ext, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
}

/** Absolute path to packages/extension (the repo's extension package root). */
export function extRoot(): string {
  return path.resolve(BENCH_DIR, "..", "..");
}

export interface ModelsConfig {
  /** Candidate models under test — driven AS the amicode agent. */
  candidates: string[];
  /** The fixed judge model for the scorer's LLM axis. */
  judge: string;
  /** Default runs per (model × scenario) cell. */
  runs: number;
}

/** Parse models.toml. Shape:
 *    judge = "amazon-bedrock/anthropic.claude-sonnet-4-6"
 *    runs = 3
 *    [[model]]  id = "..."   (repeated)  */
export function loadModels(file = path.join(BENCH_DIR, "models.toml")): ModelsConfig {
  const raw = parseToml(fs.readFileSync(file, "utf8")) as {
    judge?: string;
    runs?: number;
    model?: Array<{ id: string }>;
  };
  const candidates = (raw.model ?? []).map((m) => m.id).filter((s) => typeof s === "string" && s.trim() !== "");
  if (candidates.length === 0) throw new Error(`no [[model]] entries in ${file}`);
  if (!raw.judge) throw new Error(`missing 'judge' in ${file}`);
  return { candidates, judge: raw.judge, runs: raw.runs ?? 3 };
}

/** Coerce an unknown TOML value into a TurnExpectation (tolerant of missing keys). */
function toExpectation(v: unknown): TurnExpectation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const strArr = (x: unknown): string[] | undefined =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : undefined;
  const exp: TurnExpectation = {
    must_match: strArr(o.must_match),
    must_not_match: strArr(o.must_not_match),
    expect_tools: strArr(o.expect_tools),
    forbid_tools: strArr(o.forbid_tools),
    judge_note: typeof o.judge_note === "string" ? o.judge_note : undefined,
  };
  return exp;
}

/** Parse one scenario TOML. Shape:
 *    id = "S1"
 *    title = "..."
 *    exclude_from_headline = false
 *    judge_note = "..."
 *    [[turn]]
 *      send = "help me design a pulse"
 *      [turn.expect]
 *        must_match = ["system|platform"]
 *        must_not_match = ["max_iter|timestep"]
 *        expect_tools = ["amicode_ask"]
 *        forbid_tools = []
 *        judge_note = "..."  */
export function loadScenario(file: string): Scenario {
  const raw = parseToml(fs.readFileSync(file, "utf8")) as {
    id?: string;
    title?: string;
    exclude_from_headline?: boolean;
    judge_note?: string;
    turn?: Array<{ send?: string; expect?: unknown }>;
    stage?: Array<{
      name?: string;
      turn?: Array<{ send?: string; expect?: unknown }>;
      iterate?: { send?: string; max_iterations?: number; recovered_when?: string; expect?: unknown };
    }>;
  };
  const id = raw.id ?? path.basename(file, ".toml");
  const turns: ScenarioTurn[] = (raw.turn ?? [])
    .filter((t) => typeof t.send === "string")
    .map((t) => ({ send: t.send as string, expect: toExpectation(t.expect) }));

  const stages = (raw.stage ?? [])
    .filter((s) => typeof s.name === "string")
    .map((s) => ({
      name: s.name as string,
      turns: (s.turn ?? [])
        .filter((t) => typeof t.send === "string")
        .map((t) => ({ send: t.send as string, expect: toExpectation(t.expect) })),
      iterate:
        s.iterate && typeof s.iterate.send === "string"
          ? {
              send: s.iterate.send,
              max_iterations: s.iterate.max_iterations ?? 1,
              recovered_when: s.iterate.recovered_when,
              expect: toExpectation(s.iterate.expect),
            }
          : undefined,
    }));

  if (turns.length > 0 && stages.length > 0)
    throw new Error(`scenario ${file} declares BOTH flat [[turn]] and [[stage]] — use one form`);
  if (turns.length === 0 && stages.length === 0)
    throw new Error(`scenario ${file} has no [[turn]] or [[stage]] with a 'send'`);
  for (const st of stages)
    if (st.turns.length === 0) throw new Error(`scenario ${file} stage '${st.name}' has no turns`);

  return {
    id,
    title: raw.title ?? id,
    exclude_from_headline: raw.exclude_from_headline ?? false,
    judge_note: raw.judge_note,
    turns,
    ...(stages.length > 0 ? { stages } : {}),
  };
}

/** Load every scenarios/*.toml, sorted by filename (S1, S2, …). */
export function loadScenarios(dir = SCENARIOS_DIR): Scenario[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .sort()
    .map((f) => loadScenario(path.join(dir, f)));
}
