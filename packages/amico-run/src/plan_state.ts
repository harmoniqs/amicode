// packages/amico-run/src/plan_state.ts — derived step state and the completion rule
// (spec-20260728 §4.4, §4.5).
//
// THERE IS NO WRITE PATH FOR STEP STATE, AND THAT IS THE WHOLE DESIGN.
//
// Rev 1 of the deliberation spec said "the agent cannot move its own step todos" and tested a
// verb. That was unenforceable: `amico ledger append` accepts any schema-valid record from any
// caller (ledger_verb.ts has no per-kind authorization), the product agent holds unrestricted
// bash, and verbs.ts carries no actor. A policed rule over a writable path is an honor system.
//
// So step state is a PURE FUNCTION of rows the gates append. An agent cannot forge `passed`
// without forging a gate verdict — the same barrier that already protects every fidelity claim in
// the system. What it CAN do is append a `source: user` verdict row directly, and this module
// does not pretend otherwise; see `deriveStepStates`'s lane filter for the guarantee that IS real.
//
// Advisory todos DO have a write path (`amico plan advisory`), because they are genuine judgment:
// `fixed` / `waived <reason>` / `obsolete` are decisions a human or agent makes, not facts a gate
// establishes. Merging the two kinds would let "all todos done" mean "the gates passed and we
// ignored every critic".
import type { LedgerRecord } from "./ledger.js";

/** Plan-scoped names. Deliberately NOT the shipped session-scoped FLEET_STATES (`settled`,
 *  `blocked`) — Rev 1 reused those for the same triggering event, putting two authorities over
 *  one name. A session may reach `settled` while its plan is `active` (the user walked away). */
export type StepState = "pending" | "running" | "passed" | "failed" | "skipped";
export type PlanState = "active" | "complete" | "stalled";

/** A todo is OPEN by the absence of a row. Any of the three closures ends it. */
export type AdvisoryState = "open" | "fixed" | "waived" | "obsolete";

export interface StepView {
  id: string;
  state: StepState;
  optional?: boolean;
  /** Set when a `bypassed` row names a step the plan did NOT mark optional. That is a derivation
   *  error, not a skip: the two halves of the `skipped` producer must agree. */
  error?: string;
}

export interface AdvisoryView {
  id: string;
  state: AdvisoryState;
  reason?: string;
  lens?: string;
  claim?: string;
}

export interface PlanView {
  plan_hash: string;
  state: PlanState;
  steps: StepView[];
  advisories: AdvisoryView[];
  open_advisories: number;
  /** Why the plan is not complete, in the order a reader should act on. */
  blockers: string[];
}

type VerdictRow = Extract<LedgerRecord, { type: "verdict" }>;
type DispatchRow = Extract<LedgerRecord, { type: "dispatch" }>;
type TodoRow = Extract<LedgerRecord, { type: "todo" }>;

/** The lane filter. THIS is the anti-fabrication guarantee that is actually enforceable.
 *
 *  `source` separates real work from replayed and simulated work, and the derivation admits only
 *  `user`. A Prova gym run that exercises the whole loop appends `simulated` verdicts; without
 *  this filter those would mark real plan steps `passed`, and the lane separation would be
 *  defeated inside the very derivation it exists to protect.
 *
 *  An ABSENT source counts as user: the field is optional and pre-existing rows predate it, so
 *  excluding them would silently rewrite history as un-progressed. */
const inLane = (r: { source?: string }): boolean => r.source === undefined || r.source === "user";

/** Derive each step's state from the ledger. Keyed on (plan_hash, step_id) — NEVER step_id
 *  alone. The ledger is append-only, so after a recompile the old plan's rows remain; keying on
 *  the id alone would let them alias onto identically-named new steps and read a fresh plan as
 *  already complete. */
export function deriveStepStates(
  records: readonly LedgerRecord[],
  planHash: string,
  steps: readonly { id: string; optional?: boolean }[],
): StepView[] {
  const verdicts = records.filter(
    (r): r is VerdictRow => r.type === "verdict" && r.plan_hash === planHash && typeof r.step_id === "string" && inLane(r),
  );
  const dispatches = records.filter(
    (r): r is DispatchRow => r.type === "dispatch" && r.plan_hash === planHash && typeof r.step_id === "string" && inLane(r),
  );

  return steps.map((step) => {
    const mine = verdicts.filter((v) => v.step_id === step.id);
    const bypassed = mine.some((v) => v.verdict === "bypassed");
    const agreed = mine.some((v) => v.verdict === "agree");
    const exhausted = mine.some((v) => v.verdict === "exhausted");
    const disagreed = mine.some((v) => v.verdict === "disagree");
    const dispatched = dispatches.some((d) => d.step_id === step.id);

    // `skipped` needs BOTH halves: the plan's `optional: true` permission AND a terminal
    // `bypassed` row. A bypassed row against a non-optional step is a contradiction between the
    // two, so it is surfaced rather than silently honoured or silently ignored.
    if (bypassed) {
      if (step.optional === true) return { id: step.id, state: "skipped", optional: true };
      return {
        id: step.id,
        state: exhausted ? "failed" : agreed ? "passed" : dispatched ? "running" : "pending",
        error: `a \`bypassed\` verdict names step "${step.id}", but the compiled plan does not mark it \`optional: true\` — the bypass was NOT honoured`,
      };
    }
    if (agreed) return { id: step.id, state: "passed", ...(step.optional ? { optional: true } : {}) };
    if (exhausted) return { id: step.id, state: "failed", ...(step.optional ? { optional: true } : {}) };
    // `disagree` is NOT terminal — it is one gate attempt that failed while escalation continues
    // (`exhausted` is the terminal form, failure at the top reachable rung). But it IS evidence
    // the step is under way, and reading it as `pending` made a disagreeing step indistinguishable
    // from one never dispatched, which was a real gap in the derivation.
    if (dispatched || disagreed) return { id: step.id, state: "running", ...(step.optional ? { optional: true } : {}) };
    return { id: step.id, state: "pending", ...(step.optional ? { optional: true } : {}) };
  });
}

/** Advisory state from `todo` rows: last-ts-wins per id, and `open` is the ABSENCE of a row.
 *
 *  `fixed → obsolete` is legal (the fix turned out to be moot), so no transition is forbidden —
 *  the record keeps every step of the history and the view shows the latest. */
export function deriveAdvisories(
  records: readonly LedgerRecord[],
  planHash: string,
  declared: readonly { id: string; lens?: string; claim?: string }[],
): AdvisoryView[] {
  const rows = records
    .filter((r): r is TodoRow => r.type === "todo" && r.plan_hash === planHash && inLane(r))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const latest = new Map<string, TodoRow>();
  for (const r of rows) latest.set(r.id, r); // last-ts-wins
  return declared.map((a) => {
    const row = latest.get(a.id);
    return {
      id: a.id,
      state: (row?.state ?? "open") as AdvisoryState,
      ...(row?.reason ? { reason: row.reason } : {}),
      ...(a.lens ? { lens: a.lens } : {}),
      ...(a.claim ? { claim: a.claim } : {}),
    };
  });
}

export interface PlanShape {
  plan_hash: string;
  steps: readonly { id: string; optional?: boolean }[];
  advisories?: readonly { id: string; lens?: string; claim?: string }[];
  max_replans?: number;
}

/** The completion rule (§4.5).
 *
 *     complete ⟺ every step ∈ {passed, skipped} AND every advisory closed
 *     stalled  ⟸ gate exhaustion on any step, or the replan budget exhausted
 *
 *  The advisory conjunct is where tier-2 critics get their teeth. Critics shape the work and gate
 *  COMPLETION, never START — so a review never blocks a launch, but an ignored advisory keeps the
 *  plan from ever being finished. Dropping that conjunct would make "all todos done" mean "the
 *  gates passed and we ignored every critic", which is the exact failure the two-kind split
 *  exists to prevent. */
export function derivePlanState(
  records: readonly LedgerRecord[],
  plan: PlanShape,
  opts: { replans?: number } = {},
): PlanView {
  const steps = deriveStepStates(records, plan.plan_hash, plan.steps);
  const advisories = deriveAdvisories(records, plan.plan_hash, plan.advisories ?? []);
  const open = advisories.filter((a) => a.state === "open");
  const blockers: string[] = [];

  const failed = steps.filter((s) => s.state === "failed");
  const replansExhausted = opts.replans !== undefined && plan.max_replans !== undefined && opts.replans > plan.max_replans;

  let state: PlanState;
  if (failed.length > 0 || replansExhausted) {
    state = "stalled";
    for (const s of failed) blockers.push(`step "${s.id}" failed (gate exhaustion) — replan or revise the spec`);
    if (replansExhausted) blockers.push(`the replan budget (${plan.max_replans}) is exhausted — this needs a human decision`);
  } else if (steps.every((s) => s.state === "passed" || s.state === "skipped") && open.length === 0) {
    state = "complete";
  } else {
    state = "active";
    const notDone = steps.filter((s) => s.state !== "passed" && s.state !== "skipped");
    if (notDone.length > 0)
      blockers.push(`${notDone.length} step(s) not finished: ${notDone.map((s) => `${s.id} (${s.state})`).join(", ")}`);
    for (const a of open)
      blockers.push(`advisory "${a.id}" is open — close it with \`amico plan advisory ${a.id} --state fixed|waived --reason <r>|obsolete\``);
  }
  for (const s of steps) if (s.error) blockers.push(s.error);

  return { plan_hash: plan.plan_hash, state, steps, advisories, open_advisories: open.length, blockers };
}
