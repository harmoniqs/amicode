// ============================================================================
// STAGE 3 (part) — rubric.ts
//
// The FIXED scoring rubric: the 4 axes, the programmatic-check helpers, and the
// LLM-judge invocation (a one-shot `opencode run --pure --model <judge>`). Kept
// separate from scorer.ts so the axes/weights are one auditable place.
//
// AXES (each 0..1, higher = better):
//   1. protocol   — one-question cadence, no stage-batching, correct tool use,
//                   no hallucinated/forbidden tools. (programmatic + judge)
//   2. completion — did it accomplish the scenario's task / reach expected tools
//                   / correct physics. (programmatic + judge)
//   3. cost       — cost & latency, normalized across the cohort (lower = better,
//                   inverted to a 0..1 score). (programmatic, cohort-relative)
//   4. robustness — graceful handling of errors/contradictions, no crashes.
//                   (programmatic + judge)
//
// The judge model is intended to be Opus 4.8 but that is NOT available on this
// account — Sonnet 4.6 is the substitute (see models.toml `judge`).
// ============================================================================
import { spawn } from "node:child_process";
import { vendoredOpencodeBin } from "./config";
import type { TranscriptRecord, TurnRecord, MetaRecord } from "./types";

export const AXES = ["protocol", "completion", "cost", "robustness"] as const;
export type Axis = (typeof AXES)[number];

/** Head-to-head weighting of the axes into a single 0..1 score. Cost is real but
 *  secondary to getting the protocol/task right — tune here, one place. */
export const AXIS_WEIGHTS: Record<Axis, number> = {
  protocol: 0.35,
  completion: 0.35,
  cost: 0.1,
  robustness: 0.2,
};

// ---- programmatic checks (pure, deterministic) ------------------------------

export interface ProgrammaticResult {
  /** must_match hits / total required (1 if none required). */
  matchRate: number;
  /** 1 if no must_not_match violations, else fraction avoided. */
  avoidRate: number;
  /** expect_tools present / total expected (1 if none expected). */
  toolHitRate: number;
  /** 1 if no forbidden tools fired, else fraction avoided. */
  toolAvoidRate: number;
  /** true if opencode reported an error on any captured turn. */
  hadError: boolean;
  /** per-turn detail for the report/debugging. */
  turnNotes: string[];
}

function textOfTurn(t: TurnRecord): string {
  // Include the ask/tool input text too — some models ask in the tool call, not prose.
  const askText = t.toolCalls
    .filter((c) => c.tool === "amicode_ask")
    .map((c) => {
      const q = typeof c.input.question === "string" ? c.input.question : "";
      const opts = Array.isArray(c.input.options) ? (c.input.options as unknown[]).join(" ") : "";
      return `${q} ${opts}`;
    })
    .join("\n");
  return `${t.prose}\n${askText}`;
}

/** Run the scenario's per-turn programmatic expectations against the transcript. */
export function runProgrammaticChecks(records: TranscriptRecord[]): ProgrammaticResult {
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
  let matchNum = 0,
    matchDen = 0,
    avoidNum = 0,
    avoidDen = 0,
    toolHitNum = 0,
    toolHitDen = 0,
    toolAvoidNum = 0,
    toolAvoidDen = 0;
  let hadError = false;
  const turnNotes: string[] = [];

  for (const t of turns) {
    if (t.error) {
      hadError = true;
      turnNotes.push(`turn ${t.index}: ERROR ${t.error.name ?? ""} ${t.error.message ?? ""}`.trim());
    }
    const exp = t.expect;
    if (!exp) continue;
    const text = textOfTurn(t);
    const toolNames = new Set(t.toolCalls.map((c) => c.tool));

    for (const re of exp.must_match ?? []) {
      matchDen++;
      const hit = new RegExp(re, "i").test(text);
      if (hit) matchNum++;
      else turnNotes.push(`turn ${t.index}: MISS must_match /${re}/`);
    }
    for (const re of exp.must_not_match ?? []) {
      avoidDen++;
      const bad = new RegExp(re, "i").test(text);
      if (!bad) avoidNum++;
      else turnNotes.push(`turn ${t.index}: VIOLATION must_not_match /${re}/`);
    }
    for (const tool of exp.expect_tools ?? []) {
      toolHitDen++;
      if (toolNames.has(tool)) toolHitNum++;
      else turnNotes.push(`turn ${t.index}: missing expected tool ${tool}`);
    }
    for (const tool of exp.forbid_tools ?? []) {
      toolAvoidDen++;
      if (!toolNames.has(tool)) toolAvoidNum++;
      else turnNotes.push(`turn ${t.index}: forbidden tool fired ${tool}`);
    }
  }
  return {
    matchRate: matchDen ? matchNum / matchDen : 1,
    avoidRate: avoidDen ? avoidNum / avoidDen : 1,
    toolHitRate: toolHitDen ? toolHitNum / toolHitDen : 1,
    toolAvoidRate: toolAvoidDen ? toolAvoidNum / toolAvoidDen : 1,
    hadError,
    turnNotes,
  };
}

// ---- LLM judge --------------------------------------------------------------

export interface JudgeScores {
  protocol: number; // 0..1
  completion: number; // 0..1
  robustness: number; // 0..1
  rationale: string;
}

/** Render the transcript for the judge: user turns + agent prose + tool calls. */
export function renderTranscriptForJudge(records: TranscriptRecord[]): string {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta");
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
  const lines: string[] = [];
  if (meta) lines.push(`SCENARIO: ${meta.scenario_meta.title}`);
  for (const t of turns) {
    lines.push(`\n[USER turn ${t.index}] ${t.sent}`);
    if (t.prose.trim()) lines.push(`[AMICO prose] ${t.prose.trim()}`);
    for (const c of t.toolCalls) {
      lines.push(`[AMICO tool] ${c.tool}(${JSON.stringify(c.input)})`);
    }
    if (t.error) lines.push(`[ERROR] ${t.error.name}: ${t.error.message ?? ""}`);
  }
  return lines.join("\n");
}

/** Build the judge prompt: fixed rubric + scenario judge notes + the transcript. */
export function buildJudgePrompt(records: TranscriptRecord[]): string {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta");
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
  const scenarioNote = meta?.scenario_meta.judge_note ?? "";
  const perTurnNotes = turns
    .map((t) => (t.expect?.judge_note ? `- turn ${t.index}: ${t.expect.judge_note}` : ""))
    .filter(Boolean)
    .join("\n");
  return [
    "You are grading a QUANTUM-CONTROL pulse-design agent named Amico (running inside",
    "the Amicode VS Code extension). Amico interviews a researcher one question at a",
    "time, records the System/Formulation/Run with amicode_* tools, and launches a",
    "Piccolo (Julia) solve. You are NOT the agent — you only grade the transcript below.",
    "",
    "Grade three axes, each a number from 0.0 (terrible) to 1.0 (excellent):",
    "  protocol   — one atomic question per turn, no stage-batching, correct/legal",
    "               amicode_* tool use, NO hallucinated tools or fabricated results.",
    "  completion — accomplished the scenario's task; correct physics; reached the",
    "               expected tool bookkeeping (System→Formulation→Run as applicable).",
    "  robustness — graceful under messy/contradictory/error input; honest about",
    "               what it can't do; recovers without crashing or confabulating.",
    "",
    "SCENARIO GUIDANCE:",
    scenarioNote,
    perTurnNotes ? "PER-TURN GUIDANCE:\n" + perTurnNotes : "",
    "",
    "Respond with ONLY a single JSON object, no prose, no code fence:",
    '{"protocol": <0..1>, "completion": <0..1>, "robustness": <0..1>, "rationale": "<=60 words"}',
    "",
    "=== TRANSCRIPT ===",
    renderTranscriptForJudge(records),
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

/** Invoke the judge model one-shot via `opencode run --pure --format json`.
 *  `--pure` skips the amicode plugin/instructions so the judge is a neutral
 *  grader. Concatenates the emitted text parts and extracts the JSON object. */
export async function callJudge(judgeModel: string, prompt: string, timeoutMs = 120_000): Promise<JudgeScores> {
  const bin = vendoredOpencodeBin();
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      bin,
      ["run", "--pure", "--model", judgeModel, "--format", "json", prompt],
      {
        // Neutral config so the judge isn't shaped by any global opencode.json.
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{"$schema":"https://opencode.ai/config.json"}' },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let so = "";
    let se = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`judge timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (so += c));
    child.stderr.on("data", (c) => (se += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && so.trim() === "") reject(new Error(`judge exited ${code}: ${se.slice(0, 400)}`));
      else resolve(so);
    });
  });

  // --format json emits one JSON event per line; the assistant text is in the
  // `type:"text"` events' part.text. Concatenate them, then pull the JSON object.
  const text = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        const ev = JSON.parse(l) as { type?: string; part?: { type?: string; text?: string } };
        return ev.type === "text" && ev.part?.type === "text" ? ev.part.text ?? "" : "";
      } catch {
        return "";
      }
    })
    .join("");
  const parsed = extractJudgeJson(text);
  return parsed;
}

/** Pull the first {...} JSON object out of the judge's text; clamp to 0..1. */
export function extractJudgeJson(text: string): JudgeScores {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge produced no JSON object: ${text.slice(0, 200)}`);
  const raw = JSON.parse(m[0]) as Partial<JudgeScores>;
  const clamp = (n: unknown): number => {
    const x = typeof n === "number" ? n : Number(n);
    return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
  };
  return {
    protocol: clamp(raw.protocol),
    completion: clamp(raw.completion),
    robustness: clamp(raw.robustness),
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
  };
}
