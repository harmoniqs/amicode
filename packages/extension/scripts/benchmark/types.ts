// ============================================================================
// Shared record types for the amicode model-benchmarking harness.
//
// Four DECOUPLED stages wired by files on disk:
//   1. driver.ts    — boots opencode serve per (model × scenario × run), replays
//                      turns, writes ONE JSONL transcript per cell. Never scores.
//   2. scenarios/*.toml — data (user turns + per-turn expectations).
//   3. scorer.ts    — reads transcripts, scores 4 axes. Pure fn of transcripts.
//   4. report.ts    — aggregates 3 runs/cell, writes ranked report.md.
//
// The JSONL line union below is the ONLY contract between stages 1 and 3. Keep
// it additive: the scorer must tolerate unknown fields, and old transcripts must
// keep parsing after new fields land.
// ============================================================================

/** A single captured tool call (opencode `type:"tool"` part). Input args are the
 *  amicode_* tool's arguments — the load-bearing signal for protocol scoring. */
export interface ToolCall {
  /** The tool name, e.g. "amicode_ask", "amicode_pick_system". */
  tool: string;
  /** opencode call id (for dedup / ordering across the turn's assistant messages). */
  callID?: string;
  /** The tool's input arguments (from part.state.input). */
  input: Record<string, unknown>;
  /** completed | error | pending — opencode's tool part state.status. */
  status?: string;
}

/** Token usage for one assistant message (opencode info.tokens shape). */
export interface TokenUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

// ---- JSONL record union (one object per line in a cell transcript) ----------

/** First line of every transcript: the cell's identity + environment. */
export interface MetaRecord {
  kind: "meta";
  model: string;
  scenario: string;
  run: number;
  /** ISO timestamp of the cell start. */
  startedAt: string;
  /** opencode session id (for cross-reference / debugging). */
  sessionID: string;
  /** The scenario's declared expectations, copied in so the scorer is a pure fn
   *  of the transcript alone (never needs to re-read the scenario TOML). */
  scenario_meta: ScenarioMeta;
  /** Harness + binary provenance. */
  opencodeBin: string;
}

/** One replayed user turn and everything the agent produced in response. */
export interface TurnRecord {
  kind: "turn";
  /** 1-based turn index within the scenario. */
  index: number;
  /** The user text sent this turn. */
  sent: string;
  /** All prose text parts concatenated (assistant messages for this turn). */
  prose: string;
  /** Every tool call across all assistant messages for this turn, in order. */
  toolCalls: ToolCall[];
  /** Per-turn aggregated usage: summed across all assistant messages the turn spawned. */
  usage: {
    cost: number;
    tokens: TokenUsage;
    /** Number of assistant messages (steps) the model took for this turn. */
    assistantMessages: number;
  };
  /** Wall-clock ms for the POST that drove this turn. */
  wallMs: number;
  /** opencode model/provider ids observed on the assistant info block. */
  modelID?: string;
  providerID?: string;
  /** finish reason of the last assistant message (stop | tool_calls | length | …). */
  finish?: string;
  /** Set iff opencode reported an error on ANY assistant message this turn
   *  (info.error — comes back HTTP 200, so this is the real failure signal). */
  error?: { name?: string; message?: string; statusCode?: number };
  /** The scenario's per-turn expectations, copied in (pure-fn scorer). */
  expect?: TurnExpectation;
  /** v2: which scenario stage this turn belongs to ("nominal"/"min_time"/…).
   *  Undefined for flat v1 scenarios (no stages). Set by the driver. */
  stage?: string;
  /** v2: for an iterate stage, which cycle this turn is (0 = the stage's own
   *  turns; 1..N = injected iterate follow-ups). Undefined outside iterate. */
  iterationIndex?: number;
}

/** Terminal record when a cell crashes/times out. The batch continues. */
export interface ErrorRecord {
  kind: "error";
  /** Where it failed (boot | turn:<n> | teardown). */
  phase: string;
  message: string;
  /** Partial turns completed before the failure, for partial credit. */
  turnsCompleted: number;
}

/** Final record of a clean run: totals for the cell. */
export interface DoneRecord {
  kind: "done";
  turns: number;
  totalCost: number;
  totalWallMs: number;
  finishedAt: string;
}

/** v2: an iterate stage that never matched recovered_when within max_iterations. */
export interface StageUnrecoveredRecord {
  kind: "stage_unrecovered";
  stage: string;
  iterations: number;
}

export type TranscriptRecord =
  | MetaRecord
  | TurnRecord
  | ErrorRecord
  | DoneRecord
  | StageUnrecoveredRecord;

// ---- Scenario shape (parsed from scenarios/*.toml) --------------------------

/** Per-turn expectation block authored in the scenario TOML. All optional — a
 *  turn with no expectation block is captured but not asserted. Regex strings
 *  are compiled case-insensitively by the scorer. */
export interface TurnExpectation {
  /** Regexes that MUST match the turn's prose+ask text (all required). */
  must_match?: string[];
  /** Regexes that must NOT match (any hit is a violation). */
  must_not_match?: string[];
  /** Tool names that SHOULD appear this turn (each missing one is a miss). */
  expect_tools?: string[];
  /** Tool names that must NOT be called (hallucinated / premature). */
  forbid_tools?: string[];
  /** Free-text guidance handed to the LLM judge for THIS turn (optional). */
  judge_note?: string;
}

export interface ScenarioTurn {
  /** The user text to send. */
  send: string;
  expect?: TurnExpectation;
}

/** v2: an iterate block — a follow-up turn the driver injects after a stage's
 *  own turns to force a diagnose→re-solve cycle. `recovered_when` is a regex on
 *  the response prose/tool-input that, when matched, ends iteration early. */
export interface IterateBlock {
  /** The user turn injected to signal "your result is bad, fix it". */
  send: string;
  /** Max injected cycles before giving up (stage scored `unrecovered`). */
  max_iterations: number;
  /** Optional: regex; if the response matches, stop iterating early (recovered). */
  recovered_when?: string;
  /** Expectations applied to each injected iterate turn. */
  expect?: TurnExpectation;
}

/** v2: a named stage — its own ordered turns, plus an optional iterate block. */
export interface ScenarioStage {
  /** Stage name, stamped onto each turn's `stage` field ("nominal"/"min_time"/…). */
  name: string;
  turns: ScenarioTurn[];
  iterate?: IterateBlock;
}

/** Scenario-level metadata copied into the transcript meta record. */
export interface ScenarioMeta {
  id: string;
  title: string;
  /** Exclude this scenario's score from the head-to-head number (S5 probe). */
  exclude_from_headline?: boolean;
  /** Scenario-wide judge guidance (the rubric prompt appends per-turn notes). */
  judge_note?: string;
}

export interface Scenario extends ScenarioMeta {
  /** Flat v1 turns. Present for v1 scenarios; empty when `stages` is used. */
  turns: ScenarioTurn[];
  /** v2 multi-stage form. When present, the driver replays these in order in
   *  one session and `turns` is ignored. Mutually exclusive with a non-empty
   *  `turns` at authoring time (the loader enforces exactly one). */
  stages?: ScenarioStage[];
}
