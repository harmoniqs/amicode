// The fleet registry (fleet spec §3.2) — CLI-owned data, not a service.
//
//   ~/.amico/ops/fleet/<session_id>.toml     ONE FILE PER SESSION
//
// "single writer per file; written by the harness, read by anyone" is race-free by
// construction, so this module needs no lock: the concurrency argument is the file
// layout itself.
//
// ⚠️ THE DELIBERATE CONTRAST WITH THE RUN LEDGER. `ledger.ts` is an APPEND-ONLY,
// IMMUTABLE JSONL EVENT LOG — records accumulate and nothing is ever rewritten. This
// registry is MUTABLE PER-SESSION TOML STATE — one small record, rewritten in place as
// the session transitions. They are different by design and must NOT be forced through
// one model. What they share (fleet §3.2 Rev 4.1, scoped in the delta review, and the
// experiment-task supervisor's §7.1 shares it too) is exactly: record I/O + the no-null
// TOML conventions, single-writer discipline, adoption/rescan, and the pid-liveness
// probe. The STATE MODELS stay separate: this registry stores TRANSITION-DRIVEN state
// under a single writer; the task registry DERIVES state at read time from (record,
// liveness). The "── record I/O ──" and "── the pid-liveness probe ──" blocks below are
// the extraction point when the task supervisor lands in this repo; the transition table
// above them is not.
//
// PURITY BOUNDARY (the §8 CI requirement — "the §3.2 state machine as a pure module with
// exhaustive transition tests"): everything above "── record I/O ──" touches no
// filesystem, no clock, and no process state. `step()` and `applyEvent()` are total
// functions of their arguments; `applyEvent()` returns a NEW record and never mutates
// its input. The impure edge is confined to the bottom third of the file and is the only
// part that imports from `node:fs`.
//
// USER ACTIONS vs EVENTS. The fleet view offers three per-session actions — steer, stop,
// re-tier (§3.3) — and they are NOT events. Which §3.2 event an action produces depends
// on the record's state and (for re-tier) its base shell: a user "stop" during triage is
// the `cancel` event applied by the extension, while the same button on a `running`
// record is the `stop` event applied by the harness. `steerEventFor` / `stopEventFor` /
// `retierEventFor` are that mapping, kept pure and here so the CLI cannot invent a
// fourth reading of it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// ── §3.2 states ──────────────────────────────────────────────────────────────────
/** The six registry states. Entered when:
 *   spooling — triage call issued
 *   running  — session open / step dispatched
 *   blocked  — replan budget exhausted (§5.3) or an executor blocked-report awaiting a human
 *   settled  — work concluded normally; session idle
 *   crashed  — session/executor died abnormally
 *   killed   — user stop via the fleet view or `/fleet`  (TERMINAL) */
export const FLEET_STATES = ["spooling", "running", "blocked", "settled", "crashed", "killed"] as const;
export type FleetState = (typeof FLEET_STATES)[number];

/** The nine transition events. `stop` and `respool` are the two kill edges; they differ
 *  ONLY in whether `respooled_to` is stamped (§3.2/§3.3). */
export const FLEET_EVENTS = [
  "inject",
  "cancel",
  "crash",
  "block",
  "settle",
  "unblock",
  "resume",
  "stop",
  "respool",
] as const;
export type FleetEvent = (typeof FLEET_EVENTS)[number];

/** The live (non-terminal) states from which a user stop is offered (§3.3: "stop is
 *  available from any live state" — the fleet view offers it on `running`, `blocked`,
 *  `settled`, and `crashed`; a crashed session is stopped to RETIRE its record rather
 *  than relaunch). `spooling` takes `cancel` instead, see stopEventFor(). */
export const LIVE_STATES = ["running", "blocked", "settled", "crashed"] as const;

/** Who may APPLY a transition. Distinct from who HOLDS the record: `sweep` never holds
 *  a record, it is the one CLI-side exception that writes one (§3.2). */
export type Applier = "extension" | "harness" | "sweep";
/** Who holds (i.e. is entitled to write) a record in a given state. THE HANDOFF IS AT
 *  `running`: during `spooling` the record predates the session harness — triage is an
 *  extension-side pre-session call (§3.1) — so the extension writes it; at injection the
 *  extension writes `running` and hands the record off to the session's harness process,
 *  thereafter the only writer. */
export type Holder = "extension" | "harness";
export function recordHolder(state: FleetState): Holder {
  return state === "spooling" ? "extension" : "harness";
}

/** `killed` is terminal. A respool-stamped record is terminal for the same reason (it IS
 *  killed) — the successor lives in its own file, named by `respooled_to`. */
export function isTerminal(state: FleetState): boolean {
  return state === "killed";
}

interface Edge {
  to: FleetState;
  /** Who is entitled to apply this edge. */
  applied_by: Applier[];
  /** True on the one edge that moves the record from the extension to the harness. */
  handoff: boolean;
  /** §5.3: a human unblock re-arms the replan budget (per-step counters reset, plan-wide
   *  budget extends by one). Surfaced, never applied here — the budget lives in the plan. */
  rearms_budget: boolean;
  /** True only on `respool`, the one kill edge that stamps `respooled_to`. */
  stamps_respooled_to: boolean;
  note: string;
}

// ── the Rev 3 transition table, verbatim ─────────────────────────────────────────
// Every legal edge in §3.2, and nothing else. A missing cell is a REJECTION with a
// reason, not a silent no-op — `step()` is total over FLEET_STATES × FLEET_EVENTS.
const TABLE: { [S in FleetState]: { [E in FleetEvent]?: Edge } } = {
  spooling: {
    inject: {
      to: "running",
      applied_by: ["extension"],
      handoff: true,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "injection succeeds. The triage/resolve FAILURE paths land here too, on the `default` preset (§3.1) — a failed triage is never a blocked chat, and a triage TIMEOUT is this edge, not `crash`",
    },
    cancel: {
      to: "killed",
      applied_by: ["extension"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "user cancels during triage; applied by the extension directly, since it still holds the record (pre-handoff)",
    },
    crash: {
      to: "crashed",
      applied_by: ["extension", "sweep"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "the extension died mid-spool. A dead extension cannot write its own crash, so `fleet sweep` is an applier here (pid-liveness guarded)",
    },
  },
  running: {
    block: {
      to: "blocked",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "replan budget exhausted (§5.3) or an executor blocked-report awaiting a human; gate exhaustion lands here too and does NOT touch the replan budget (§8)",
    },
    settle: {
      to: "settled",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "work concluded normally; the session goes idle",
    },
    crash: {
      to: "crashed",
      applied_by: ["harness", "sweep"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "session/executor died abnormally. `fleet sweep` is the CLI-side applier for an orphaned record whose harness pid is gone (§3.2's one write exception)",
    },
    stop: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "user stop; the harness writes `killed` when it applies the enqueued stop signal",
    },
    respool: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: true,
      note: "a RESIDENT re-tier is a respool (§3.3): close the session and reopen on the amended profile — explicitly a new session, never a mid-session rebind",
    },
  },
  blocked: {
    unblock: {
      to: "running",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: true,
      stamps_respooled_to: false,
      note: "a human unblocks; the replan budget is RE-ARMED — per-step counters reset and the plan-wide budget extends by one, because the human has taken responsibility for continuing (§5.3)",
    },
    stop: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "user stop from a live state (§3.3)",
    },
    respool: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: true,
      note: "resident re-tier = respool (§3.3)",
    },
  },
  settled: {
    resume: {
      to: "running",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "the user returns to the chat and an idle session picks work back up",
    },
    stop: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "user stop from a live state (§3.3)",
    },
    respool: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: true,
      note: "resident re-tier = respool (§3.3)",
    },
  },
  crashed: {
    resume: {
      to: "running",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "the user returns to the chat; a crashed session RELAUNCHES ON ITS RECORDED PROFILE (§3.2) — which is why the inline profile copy is part of the record",
    },
    stop: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: false,
      note: "a crashed session is stopped to RETIRE its record rather than relaunch (§3.3)",
    },
    respool: {
      to: "killed",
      applied_by: ["harness"],
      handoff: false,
      rearms_budget: false,
      stamps_respooled_to: true,
      note: "resident re-tier = respool (§3.3)",
    },
  },
  // `killed` is terminal — no edges at all. `killed` and respool-stamped records are the
  // only fully terminal states (§3.2).
  killed: {},
};

/** Why a given (state, event) pair is not in the table. Specific reasons beat a generic
 *  "illegal transition": each one names the edge the caller probably wanted. */
function rejection(from: FleetState, event: FleetEvent): string {
  if (from === "killed") {
    return "`killed` is terminal (§3.2) — a killed record accepts no event; a resident respool continues in the SUCCESSOR session named by `respooled_to`, in its own file";
  }
  if (event === "stop" && from === "spooling") {
    return "`stop` is a harness-applied signal and `spooling` predates the harness — a user stop during triage is the `cancel` event, applied by the extension directly (§3.2 single-writer handoff). Use stopEventFor() to map the user action to the right event";
  }
  if (event === "cancel") {
    return "`cancel` is the spooling-time kill, applied by the extension before the handoff (§3.2); after injection the kill edge is `stop`";
  }
  if (event === "inject") {
    return "`inject` is the spooling → running handoff and applies only to a `spooling` record (§3.1); there is no mid-session agent rebinding in v1";
  }
  if (event === "crash") {
    return "§3.2's transition table has no `" + from + "` → crashed edge: a blocked record is a HUMAN DECISION POINT and a settled record concluded normally — neither may be laundered into a crash. `fleet sweep` reports such an orphaned record instead of rewriting it";
  }
  if (event === "unblock") {
    return "`unblock` applies only to a `blocked` record — it is the edge that re-arms the replan budget (§5.3), so it must not be reachable from a state that never spent it";
  }
  if (event === "resume") {
    return "`resume` applies only to an idle (`settled`) or dead (`crashed`) record — the user returning to the chat (§3.2)";
  }
  if (event === "block" || event === "settle") {
    return "`" + event + "` is a running-session outcome and applies only to a `running` record (§3.2)";
  }
  if (event === "respool") {
    return "`respool` is a kill from a LIVE state (" + LIVE_STATES.join(" | ") + "); a `spooling` session has not opened yet, so there is nothing to reopen — cancel and re-triage instead (§3.3)";
  }
  return `no \`${from}\` → \`${event}\` edge in the §3.2 transition table`;
}

export interface StepOk {
  ok: true;
  from: FleetState;
  event: FleetEvent;
  to: FleetState;
  applied_by: Applier[];
  /** The extension → harness writer handoff (true on `spooling` → `running` only). */
  handoff: boolean;
  holder_before: Holder;
  holder_after: Holder;
  rearms_budget: boolean;
  stamps_respooled_to: boolean;
  terminal: boolean;
  note: string;
}
export interface StepErr {
  ok: false;
  from: FleetState;
  event: FleetEvent;
  reason: string;
  legal_events: FleetEvent[];
}
export type StepResult = StepOk | StepErr;

/** THE transition function: total over FLEET_STATES × FLEET_EVENTS, exactly one outcome
 *  per cell, no side effects. Everything else in this file is bookkeeping around it. */
export function step(from: FleetState, event: FleetEvent): StepResult {
  const edge = TABLE[from][event];
  if (!edge) {
    return { ok: false, from, event, reason: rejection(from, event), legal_events: legalEvents(from) };
  }
  return {
    ok: true,
    from,
    event,
    to: edge.to,
    applied_by: [...edge.applied_by],
    handoff: edge.handoff,
    holder_before: recordHolder(from),
    holder_after: recordHolder(edge.to),
    rearms_budget: edge.rearms_budget,
    stamps_respooled_to: edge.stamps_respooled_to,
    terminal: isTerminal(edge.to),
    note: edge.note,
  };
}

/** The events legal from a state, in FLEET_EVENTS order. Empty for `killed`. */
export function legalEvents(from: FleetState): FleetEvent[] {
  return FLEET_EVENTS.filter((e) => TABLE[from][e] !== undefined);
}

/** Is a string one of the six states / nine events? (Total, for validating input data.) */
export function isFleetState(v: unknown): v is FleetState {
  return typeof v === "string" && (FLEET_STATES as readonly string[]).includes(v);
}
export function isFleetEvent(v: unknown): v is FleetEvent {
  return typeof v === "string" && (FLEET_EVENTS as readonly string[]).includes(v);
}

// ── user actions → events (§3.3's three per-session actions) ──────────────────────
export type FleetAction = "steer" | "stop" | "re-tier";

export interface ActionMap {
  ok: true;
  action: FleetAction;
  /** The §3.2 event the harness will apply. "" when the action changes no state (an
   *  upward re-tier stamp applies at the next step-boundary dispatch, and steering a
   *  running session is just an instruction). */
  event: FleetEvent | "";
  reason: string;
}
export interface ActionErr {
  ok: false;
  action: FleetAction;
  reason: string;
}

/** STEER — "send an instruction into the session" (§3.3). The instruction itself changes
 *  no state, but the state it lands in decides what the harness does with it:
 *    running  → no transition; the instruction joins the live turn
 *    blocked  → `unblock`. With only steer/stop/re-tier on offer, an instruction into a
 *               blocked session IS the human unblock, and §5.3 is explicit that this
 *               re-arms the replan budget because the human took responsibility for
 *               continuing. Carrying the event on the signal keeps that re-arm auditable
 *               instead of implicit.
 *    settled  → `resume`; an idle session picks work back up (§3.2 settled → running). */
export function steerEventFor(state: FleetState): ActionMap | ActionErr {
  if (state === "running") return { ok: true, action: "steer", event: "", reason: "the instruction joins the live turn; no state change" };
  if (state === "blocked") {
    return {
      ok: true,
      action: "steer",
      event: "unblock",
      reason: "an instruction into a blocked session is the human unblock (`blocked` → `running`), which RE-ARMS the replan budget (§5.3)",
    };
  }
  if (state === "settled") {
    return { ok: true, action: "steer", event: "resume", reason: "an idle session picks work back up (`settled` → `running`)" };
  }
  if (state === "spooling") {
    return { ok: false, action: "steer", reason: "there is no session yet — triage runs BEFORE the session opens (§3.1), so there is nothing to steer" };
  }
  if (state === "crashed") {
    return {
      ok: false,
      action: "steer",
      reason: "a crashed record has no live harness to receive an instruction. Returning to the chat relaunches it on its recorded profile (`crashed` → `running`); the fleet view's action on a crashed record is `stop`, to retire it (§3.3)",
    };
  }
  return { ok: false, action: "steer", reason: "`killed` is terminal (§3.2)" };
}

/** STOP — available from any live state (§3.3), but which EVENT it is depends on who
 *  holds the record: during triage the extension applies `cancel`; after the handoff the
 *  harness applies `stop`. */
export function stopEventFor(state: FleetState): ActionMap | ActionErr {
  if (state === "spooling") {
    return {
      ok: true,
      action: "stop",
      event: "cancel",
      reason: "a stop during triage is the `cancel` edge, applied by the extension — it still holds the record pre-handoff (§3.2)",
    };
  }
  if ((LIVE_STATES as readonly string[]).includes(state)) {
    return {
      ok: true,
      action: "stop",
      event: "stop",
      reason:
        state === "crashed"
          ? "a crashed session is stopped to RETIRE its record rather than relaunch (§3.3)"
          : "user stop is available from any live state (§3.3)",
    };
  }
  return { ok: false, action: "stop", reason: "`killed` is terminal (§3.2) — the record is already retired" };
}

/** RE-TIER (§3.3) — two different operations behind one button, chosen by base shell:
 *    resident            → RESPOOL: kill the record (stamping `respooled_to`) and reopen
 *                          the session on the amended profile. A new session, not a rebind.
 *    executor / headless → a plan-walking session. UPWARD-ONLY, applied at the next
 *                          step-boundary dispatch; in-flight steps finish on their old
 *                          tier, so there is NO state change. A DOWNWARD re-tier is a
 *                          replan, not a stamp change (step bodies were written for the
 *                          stronger reader, §5.1), and consumes one replan-budget unit. */
export function retierEventFor(state: FleetState, base: string): ActionMap | ActionErr {
  if (state === "killed") return { ok: false, action: "re-tier", reason: "`killed` is terminal (§3.2)" };
  if (state === "spooling") {
    return {
      ok: false,
      action: "re-tier",
      reason: "the session has not opened yet — the triage call is what stamps the resident's tier (§3.1). Cancel and re-triage instead of re-tiering",
    };
  }
  if (base === "resident") {
    return {
      ok: true,
      action: "re-tier",
      event: "respool",
      reason: "a resident re-tier is a respool: the record is killed with `respooled_to` stamped and the session reopens on the amended profile (§3.3)",
    };
  }
  if (state === "crashed") {
    return {
      ok: false,
      action: "re-tier",
      reason: "a crashed plan-walking session has no next step-boundary dispatch to apply the new stamp at; relaunch it (`crashed` → `running`) and re-tier the live session",
    };
  }
  if (state === "settled") {
    return {
      ok: false,
      action: "re-tier",
      reason: "a settled plan has no subsequent executors to receive the new stamp — re-tier applies at the NEXT step-boundary dispatch (§3.3)",
    };
  }
  return {
    ok: true,
    action: "re-tier",
    event: "",
    reason: "the new stamp applies at the next step-boundary dispatch; in-flight steps finish on their old tier, so the record's state does not change (§3.3)",
  };
}

// ── the record (one TOML file per session) ────────────────────────────────────────
/** The inline copy of the resolved loadout (§3.2 "profile (inline copy)"). It is a COPY
 *  on purpose: a `crashed` session relaunches on its RECORDED profile, so the record must
 *  survive edits to the profile tree. Validation here is SHAPE ONLY — `amico profile
 *  resolve` (profile_verb.ts) owns the vocabularies, and duplicating its lint here would
 *  give the system two answers to one question. */
export interface FleetProfile {
  name: string;
  base: string;
  model: string;
  variant: string;
  task_type: string;
  skills: string[];
  gates: string[];
  permissions: Record<string, string>;
}

/** The §3.2 record: `{session_id, profile (inline copy), state, current_step, started,
 *  tokens, runtime, respooled_to?}`, plus `schema`, `pid` and `host`.
 *
 *  NO TOML NULLS ANYWHERE: absent string → "", absent integer → 0 (the project-wide ops
 *  convention; the reader side is python3.9/tomli, which has no null at all). Every field
 *  is therefore REQUIRED and total — `respooled_to?` in the spec's notation means "empty
 *  unless killed-by-respool", not "key may be missing".
 *
 *  `schema = 1` is carried like every other ops TOML (task.toml, profiles/*.toml) so a
 *  future record revision is detectable rather than guessed at.
 *
 *  `pid` is THE CURRENT HOLDER's pid — the extension while `spooling`, the harness after
 *  the handoff — and 0 means "unknown". It is not in the spec's field list, but §3.2
 *  requires `fleet sweep` to be "guarded by pid liveness", which is unimplementable
 *  without it; `host` comes with it, because a foreign host makes liveness UNKNOWABLE
 *  rather than dead (the same guard the task supervisor's probe uses).
 *
 *  `runtime` is accumulated wall-clock SECONDS, the cost partner of `tokens`: `started`
 *  already carries the instant and the inline profile already carries which runtimes the
 *  loadout compiles to, so a second reading of the field would be redundant — and
 *  (tokens, seconds) is the pair the fleet view needs to answer "which of these campaigns
 *  should I kill given Thursday's deadline?" (§3.3). Frozen at the writer's last tick;
 *  readers that want live elapsed time derive it from `started`. */
export interface FleetRecord {
  schema: number;
  session_id: string;
  state: FleetState;
  current_step: string;
  started: string;
  tokens: number;
  runtime: number;
  respooled_to: string;
  pid: number;
  host: string;
  profile: FleetProfile;
}

export const FLEET_RECORD_SCHEMA = 1;

/** A session id has to be safe as a FILENAME STEM — the record path is
 *  `<root>/<session_id>.toml` and the signal dir is `<root>/<session_id>.signal.d/`, so
 *  a `/` or `..` in an id would escape the registry root. Rejected as data, never
 *  sanitized silently. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 128 && SESSION_ID.test(id) && !id.includes("..");
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

/** smol-toml parses a BARE TOML datetime into a Date/TomlDate rather than a string. A
 *  hand-written record may well spell `started` bare, so coerce it back to ISO-8601 —
 *  same accommodation repertoire.ts makes for bare dates. */
function isoish(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

/** Fill the no-null defaults over a partial record. Pure and total: the output has every
 *  field, with "" / 0 where the input had nothing. This is the ONLY place defaults are
 *  written, so a null can never reach the TOML. */
export function normalizeRecord(partial: Partial<FleetRecord> & { session_id: string; state: FleetState }): FleetRecord {
  const p = partial.profile;
  return {
    schema: partial.schema ?? FLEET_RECORD_SCHEMA,
    session_id: partial.session_id,
    state: partial.state,
    current_step: partial.current_step ?? "",
    started: partial.started ?? "",
    tokens: partial.tokens ?? 0,
    runtime: partial.runtime ?? 0,
    respooled_to: partial.respooled_to ?? "",
    pid: partial.pid ?? 0,
    host: partial.host ?? "",
    profile: {
      name: p?.name ?? "",
      base: p?.base ?? "",
      model: p?.model ?? "",
      variant: p?.variant ?? "",
      task_type: p?.task_type ?? "",
      skills: p?.skills ? [...p.skills] : [],
      gates: p?.gates ? [...p.gates] : [],
      permissions: { ...(p?.permissions ?? {}) },
    },
  };
}

export interface ValidateOk {
  ok: true;
  record: FleetRecord;
  warnings: string[];
}
export interface ValidateErr {
  ok: false;
  errors: string[];
  warnings: string[];
}

/** Validate a parsed object as a record. Errors-as-data, field-precise, total — never
 *  throws. Absent-as-empty is ACCEPTED (that is the convention); an explicit `null` is an
 *  ERROR, because emitting one would break the tomli reader. */
export function validateRecord(obj: unknown): ValidateOk | ValidateErr {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["record must be a TOML table"], warnings };
  }
  const o = obj as Record<string, unknown>;

  // No nulls, anywhere, at any depth — the convention is empty-string/zero.
  const nulls: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === null) {
      nulls.push(path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v instanceof Date) return;
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(o, "");
  for (const p of nulls) errors.push(`${p} is null — the ops TOML convention has NO nulls (empty string for an absent string, 0 for an absent integer)`);

  if (o.schema !== undefined && o.schema !== FLEET_RECORD_SCHEMA) {
    errors.push(`schema must be ${FLEET_RECORD_SCHEMA} (got ${JSON.stringify(o.schema)})`);
  }
  if (!isValidSessionId(o.session_id)) {
    errors.push(
      `session_id ${JSON.stringify(o.session_id)} is missing or not a safe filename stem (/^[A-Za-z0-9][A-Za-z0-9._-]*$/, no "..") — the record path is <root>/<session_id>.toml`,
    );
  }
  if (!isFleetState(o.state)) {
    errors.push(`state ${JSON.stringify(o.state)} must be one of (${FLEET_STATES.join(", ")})`);
  }
  for (const k of ["current_step", "respooled_to", "host"] as const) {
    if (o[k] !== undefined && str(o[k]) === undefined) errors.push(`${k} must be a string ("" when absent)`);
  }
  if (o.started !== undefined && isoish(o.started) === undefined) errors.push(`started must be an ISO-8601 string ("" when absent)`);
  for (const k of ["tokens", "runtime", "pid"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${k} must be a number (0 when absent)`);
    else if (v < 0) errors.push(`${k} must be >= 0 (got ${v})`);
  }

  // profile: SHAPE only — profile_verb.ts owns the vocabularies (one answer per question).
  const prof = o.profile;
  if (prof === undefined || typeof prof !== "object" || Array.isArray(prof)) {
    errors.push(`missing required table "profile" (the inline loadout copy a crashed session relaunches on)`);
  } else {
    const pr = prof as Record<string, unknown>;
    for (const k of ["name", "base", "model", "variant", "task_type"] as const) {
      if (pr[k] !== undefined && str(pr[k]) === undefined) errors.push(`profile.${k} must be a string`);
    }
    for (const k of ["skills", "gates"] as const) {
      if (pr[k] !== undefined && strList(pr[k]) === undefined) errors.push(`profile.${k} must be a list of strings`);
    }
    if (pr.permissions !== undefined) {
      if (typeof pr.permissions !== "object" || pr.permissions === null || Array.isArray(pr.permissions)) {
        errors.push("profile.permissions must be a table of strings");
      } else {
        for (const [k, v] of Object.entries(pr.permissions as Record<string, unknown>)) {
          if (str(v) === undefined) errors.push(`profile.permissions.${k} must be a string`);
        }
      }
    }
    if (!str(pr.model) || !str(pr.variant)) {
      warnings.push("profile.model / profile.variant are the tier stamp and should ALWAYS be co-stamped (§2) — an empty one loses effort control silently");
    }
  }

  // respooled_to is stamped ONLY on a killed-by-respool record (§3.2/§3.3).
  const respooled = str(o.respooled_to) ?? "";
  if (respooled !== "" && o.state !== "killed") {
    errors.push(`respooled_to = ${JSON.stringify(respooled)} on a "${String(o.state)}" record — it is stamped ONLY on a killed-by-respool record (§3.2)`);
  }
  if (respooled !== "" && !isValidSessionId(respooled)) {
    errors.push(`respooled_to ${JSON.stringify(respooled)} must be a valid session id (it names the successor session's record file)`);
  }
  if (respooled !== "" && respooled === o.session_id) errors.push("respooled_to must name a DIFFERENT session — a respool opens a new session, it is not a rebind (§3.3)");

  if (errors.length > 0) return { ok: false, errors, warnings };
  const record = normalizeRecord({
    ...(o as Partial<FleetRecord>),
    session_id: o.session_id as string,
    state: o.state as FleetState,
    started: isoish(o.started) ?? "",
  });
  return { ok: true, record, warnings };
}

// ── applying an event to a record (still PURE) ───────────────────────────────────
export interface ApplyOptions {
  /** REQUIRED on `respool` (and rejected on every other event): the successor session id. */
  respooled_to?: string;
  /** The pid of the holder AFTER the transition — the harness pid on `inject` / `unblock`
   *  / `resume`. Terminal edges zero it out regardless. */
  pid?: number;
  host?: string;
  current_step?: string;
  tokens?: number;
  runtime?: number;
}

export interface ApplyOk {
  ok: true;
  record: FleetRecord;
  transition: StepOk;
}
export interface ApplyErr {
  ok: false;
  errors: string[];
  transition?: StepErr;
}

/** Apply an event to a record, returning a NEW record. Pure: no clock, no filesystem, no
 *  mutation of the input. The single place `respooled_to` is ever written. */
export function applyEvent(rec: FleetRecord, event: FleetEvent, opts: ApplyOptions = {}): ApplyOk | ApplyErr {
  const t = step(rec.state, event);
  if (!t.ok) return { ok: false, errors: [t.reason], transition: t };

  const respooled = opts.respooled_to ?? "";
  if (t.stamps_respooled_to) {
    if (respooled === "") {
      return { ok: false, errors: ["`respool` requires the successor session id — `respooled_to` is what distinguishes a respool-kill from a plain stop (§3.2)"] };
    }
    if (!isValidSessionId(respooled)) return { ok: false, errors: [`respooled_to ${JSON.stringify(respooled)} is not a valid session id`] };
    if (respooled === rec.session_id) return { ok: false, errors: ["respooled_to must name a DIFFERENT session — a respool opens a new session, it is not a mid-session rebind (§3.3)"] };
  } else if (respooled !== "") {
    return {
      ok: false,
      errors: [
        `respooled_to was supplied on a \`${event}\` transition — it is stamped ONLY on a respool-kill (§3.2). A plain stop leaves it empty, which is how the fleet view tells a retired session from a re-tiered one`,
      ],
    };
  }

  // A killed or crashed record has no live holder: zero the pid so nothing ever probes a
  // recycled one. Otherwise take the supplied pid, else carry the current one forward.
  const nextPid = isTerminal(t.to) || t.to === "crashed" ? 0 : (opts.pid ?? rec.pid);

  return {
    ok: true,
    record: {
      ...rec,
      state: t.to,
      pid: nextPid,
      host: opts.host ?? rec.host,
      current_step: opts.current_step ?? rec.current_step,
      tokens: opts.tokens ?? rec.tokens,
      runtime: opts.runtime ?? rec.runtime,
      respooled_to: t.stamps_respooled_to ? respooled : rec.respooled_to,
      profile: { ...rec.profile, skills: [...rec.profile.skills], gates: [...rec.profile.gates], permissions: { ...rec.profile.permissions } },
    },
    transition: t,
  };
}

// ── TOML serialization (pure: string in, string out) ─────────────────────────────
/** Serialize a record to TOML in a CANONICAL key order (scalars first, then the
 *  `[profile]` table — TOML requires it, and a stable order keeps diffs readable). */
export function toToml(rec: FleetRecord): string {
  const canonical = {
    schema: rec.schema,
    session_id: rec.session_id,
    state: rec.state,
    current_step: rec.current_step,
    started: rec.started,
    tokens: rec.tokens,
    runtime: rec.runtime,
    respooled_to: rec.respooled_to,
    pid: rec.pid,
    host: rec.host,
    profile: {
      name: rec.profile.name,
      base: rec.profile.base,
      model: rec.profile.model,
      variant: rec.profile.variant,
      task_type: rec.profile.task_type,
      skills: rec.profile.skills,
      gates: rec.profile.gates,
      permissions: rec.profile.permissions,
    },
  };
  return stringifyToml(canonical) + "\n";
}

/** Parse + validate TOML text as a record. Errors-as-data; never throws. */
export function fromToml(text: string): ValidateOk | ValidateErr {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    return { ok: false, errors: [`TOML parse error — ${e instanceof Error ? e.message : String(e)}`], warnings: [] };
  }
  return validateRecord(parsed);
}

// ── signal files (the write verbs' only output) ───────────────────────────────────
/** An enqueued fleet-view action. `amico fleet steer|stop|re-tier` write these and
 *  NOTHING else — the harness applies them on its next tick, which is what keeps the
 *  single-writer discipline intact with a CLI in the picture (§3.2).
 *
 *  The signal carries the PROJECTED transition (`event` + `projected_state`) as computed
 *  by the pure machine at enqueue time, so the applier does not re-derive policy and a
 *  stale signal is visibly stale. `respooled_to` is deliberately absent: only the harness
 *  knows the successor session id, because only the harness opens it. */
export interface FleetSignal {
  schema: number;
  signal: FleetAction;
  session_id: string;
  enqueued: string;
  enqueued_by_pid: number;
  /** The §3.2 event the applier should apply; "" when the action changes no state. */
  event: FleetEvent | "";
  projected_state: FleetState | "";
  applied_by: Applier | "";
  /** steer only. */
  message: string;
  /** re-tier only. */
  model: string;
  variant: string;
  direction: string;
  /** re-tier only: a downward re-tier of a plan-walking session is a REPLAN, and costs
   *  one unit of the plan's replan budget (§3.3/§5.3). */
  replan: boolean;
  /** True when the harness must re-arm the replan budget as it applies this signal (§5.3). */
  rearms_budget: boolean;
  reason: string;
}

export const SIGNAL_DIR_SUFFIX = ".signal.d";

/** Serialize a signal to TOML (same no-null conventions as the record). */
export function signalToToml(sig: FleetSignal): string {
  return stringifyToml({ ...sig } as Record<string, unknown>) + "\n";
}

/** Parse a signal file's text. Errors-as-data. */
export function signalFromToml(text: string): { ok: true; signal: FleetSignal } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    return { ok: false, errors: [`TOML parse error — ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, errors: ["signal must be a TOML table"] };
  const o = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const action = str(o.signal);
  if (action !== "steer" && action !== "stop" && action !== "re-tier") errors.push(`signal must be one of (steer, stop, re-tier) (got ${JSON.stringify(o.signal)})`);
  if (!isValidSessionId(o.session_id)) errors.push(`session_id ${JSON.stringify(o.session_id)} is not a valid session id`);
  const ev = str(o.event) ?? "";
  if (ev !== "" && !isFleetEvent(ev)) errors.push(`event ${JSON.stringify(o.event)} must be a §3.2 event or "" (no state change)`);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    signal: {
      schema: typeof o.schema === "number" ? o.schema : FLEET_RECORD_SCHEMA,
      signal: action as FleetAction,
      session_id: o.session_id as string,
      enqueued: isoish(o.enqueued) ?? "",
      enqueued_by_pid: typeof o.enqueued_by_pid === "number" ? o.enqueued_by_pid : 0,
      event: ev as FleetEvent | "",
      projected_state: (isFleetState(o.projected_state) ? o.projected_state : "") as FleetState | "",
      applied_by: (str(o.applied_by) ?? "") as Applier | "",
      message: str(o.message) ?? "",
      model: str(o.model) ?? "",
      variant: str(o.variant) ?? "",
      direction: str(o.direction) ?? "",
      replan: o.replan === true,
      rearms_budget: o.rearms_budget === true,
      reason: str(o.reason) ?? "",
    },
  };
}

// ── record I/O ───────────────────────────────────────────────────────────────────
// ⚠️ THE IMPURE EDGE STARTS HERE. Everything above is a total function of its arguments.
// This block + the pid probe below are the surface the experiment-task supervisor shares
// (fleet §3.2 Rev 4.1): record I/O, the no-null conventions, single-writer discipline,
// adoption/rescan, pid liveness. The transition table is NOT shared — that registry
// derives state at read time; this one stores it.

/** The registry root. Precedence: explicit argument (tests, `--root`) → `$AMICO_FLEET_DIR`
 *  → `~/.amico/ops/fleet` (§3.2). Mirrors ledger.ts's single-env idiom. */
export function fleetRoot(explicit?: string): string {
  return explicit || process.env.AMICO_FLEET_DIR || join(homedir(), ".amico", "ops", "fleet");
}

export function recordPath(root: string, session_id: string): string {
  return join(root, `${session_id}.toml`);
}
export function signalDirPath(root: string, session_id: string): string {
  return join(root, `${session_id}${SIGNAL_DIR_SUFFIX}`);
}

/** The local host name, for the liveness guard. */
export function localHost(): string {
  return hostname();
}

/** Read one record. Missing file → ok:false with a `missing` flag so callers can tell
 *  "no such session" from "corrupt record". */
export function readRecord(root: string, session_id: string): (ValidateOk & { path: string }) | (ValidateErr & { path: string; missing: boolean }) {
  const path = recordPath(root, session_id);
  if (!isValidSessionId(session_id)) {
    return { ok: false, errors: [`session_id ${JSON.stringify(session_id)} is not a valid session id`], warnings: [], path, missing: false };
  }
  if (!existsSync(path)) return { ok: false, errors: [`no such session record: ${path}`], warnings: [], path, missing: true };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, errors: [`could not read ${path} — ${e instanceof Error ? e.message : String(e)}`], warnings: [], path, missing: false };
  }
  const r = fromToml(text);
  return r.ok ? { ...r, path } : { ...r, path, missing: false };
}

/** Write a record atomically (tmp + rename), so a reader never sees a partial record.
 *  ONE WRITER PER FILE is the caller's responsibility — that is the §3.2 discipline. In
 *  this package exactly three paths are entitled to call this: `fleet sweep` (the
 *  pid-liveness-guarded orphan adoption), and the #426 holder verbs — `fleet launch`
 *  (creation, ONCE — a record that already exists is refused, so creation cannot race
 *  a second writer) and `fleet finish` (the holder's terminal write, guarded by pid
 *  identity with the record). Everything else enqueues a signal and writes nothing. */
export function writeRecord(root: string, rec: FleetRecord): string {
  mkdirSync(root, { recursive: true });
  const path = recordPath(root, rec.session_id);
  const tmp = join(root, `.${rec.session_id}.toml.tmp-${process.pid}`);
  writeFileSync(tmp, toToml(rec));
  renameSync(tmp, path);
  return path;
}

/** Every session id with a record in the root, sorted. Missing root → []. Dot-files and
 *  the tmp files above are skipped; a `<id>.signal.d/` directory is not a record. */
export function listSessionIds(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".") || !name.endsWith(".toml")) continue;
    const id = name.slice(0, -".toml".length);
    if (isValidSessionId(id)) out.push(id);
  }
  return out.sort();
}

/** Rescan: read every record in the root. ADOPTS whatever it finds and never deletes —
 *  an unreadable record is reported errors-as-data, not skipped silently. */
export function readAllRecords(root: string): { records: FleetRecord[]; unreadable: Array<{ session_id: string; path: string; errors: string[] }> } {
  const records: FleetRecord[] = [];
  const unreadable: Array<{ session_id: string; path: string; errors: string[] }> = [];
  for (const id of listSessionIds(root)) {
    const r = readRecord(root, id);
    if (r.ok) records.push(r.record);
    else unreadable.push({ session_id: id, path: r.path, errors: r.errors });
  }
  return { records, unreadable };
}

/** Signal file names: `<epoch-ms>-<seq>-<pid>-<action>.toml`, both numbers fixed-width so
 *  LEXICOGRAPHIC order IS enqueue order. The `seq` field is load-bearing, not decoration:
 *  epoch-ms alone ties for enqueues within the same millisecond, and a tie then sorts by
 *  the ACTION NAME — which silently reorders a burst (`re-tier` before `steer` before
 *  `stop`), exactly the thing the harness must not do to a tick's worth of signals. */
const SIGNAL_NAME = /^(\d{13})-(\d{6})-(\d+)-(steer|stop|re-tier)\.toml$/;

/** Enqueue a signal file under `<root>/<session_id>.signal.d/`. `seq` is one past the
 *  highest sequence still pending in that directory, so a burst keeps arrival order even
 *  inside one millisecond. Written tmp+rename, so a harness ticking mid-write never reads
 *  a partial signal. Returns the path written. */
export function enqueueSignal(root: string, sig: FleetSignal, now: number = Date.now()): string {
  const dir = signalDirPath(root, sig.session_id);
  mkdirSync(dir, { recursive: true });
  let maxSeq = -1;
  for (const name of readdirSync(dir)) {
    const m = SIGNAL_NAME.exec(name);
    if (m) maxSeq = Math.max(maxSeq, Number(m[2]));
  }
  const ms = String(now).padStart(13, "0");
  let seq = maxSeq + 1;
  let name = `${ms}-${String(seq).padStart(6, "0")}-${process.pid}-${sig.signal}.toml`;
  while (existsSync(join(dir, name))) {
    seq += 1; // a concurrent enqueuer took this sequence
    name = `${ms}-${String(seq).padStart(6, "0")}-${process.pid}-${sig.signal}.toml`;
  }
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  writeFileSync(tmp, signalToToml(sig));
  renameSync(tmp, join(dir, name));
  return join(dir, name);
}

/** The pending signals for a session, in enqueue order. Unparseable files are reported,
 *  never dropped. */
export function listSignals(root: string, session_id: string): Array<{ file: string; signal?: FleetSignal; errors?: string[] }> {
  const dir = signalDirPath(root, session_id);
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; signal?: FleetSignal; errors?: string[] }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || !name.endsWith(".toml")) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      out.push({ file: name, errors: [`could not read ${path} — ${e instanceof Error ? e.message : String(e)}`] });
      continue;
    }
    const r = signalFromToml(text);
    if (r.ok) out.push({ file: name, signal: r.signal });
    else out.push({ file: name, errors: r.errors });
  }
  return out;
}

// ── the pid-liveness probe ───────────────────────────────────────────────────────
/** Signal 0: "does this pid exist and may I signal it". The shared probe (fleet §3.2 Rev
 *  4.1 / the task supervisor's §7.1). Honest coverage: it does NOT detect same-host pid
 *  recycling after a reboot, and it is meaningless for a record written on another host —
 *  which is why `host` gates its use rather than the probe pretending to know. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process EXISTS but belongs to another user — alive, not orphaned.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Why a record is (or is not) sweepable — the pure part of `fleet sweep`'s decision,
 *  separated from the probe so the policy is testable without spawning processes. Feed it
 *  the probe's answer; it never calls the probe itself. */
export type SweepVerdict =
  | { sweep: true; reason: string }
  | { sweep: false; reason: string; code: "terminal" | "no_crash_edge" | "foreign_host" | "pid_unknown" | "alive" };

export function sweepVerdict(rec: FleetRecord, opts: { local_host: string; pid_alive: boolean }): SweepVerdict {
  if (isTerminal(rec.state)) return { sweep: false, code: "terminal", reason: "`killed` is terminal — the record is already retired (§3.2)" };
  if (!step(rec.state, "crash").ok) {
    return {
      sweep: false,
      code: "no_crash_edge",
      reason: `§3.2 has no \`${rec.state}\` → crashed edge, so an orphaned record in this state is REPORTED, not rewritten (a blocked record is a human decision point; a settled one concluded normally)`,
    };
  }
  if (rec.host !== "" && opts.local_host !== "" && rec.host !== opts.local_host) {
    return {
      sweep: false,
      code: "foreign_host",
      reason: `record host "${rec.host}" != local host "${opts.local_host}" — pid liveness is UNKNOWABLE across hosts, and unknowable is never dead`,
    };
  }
  if (rec.pid === 0) {
    return {
      sweep: false,
      code: "pid_unknown",
      reason: "pid = 0 means the holder's pid is unknown (handoff not yet stamped) — an unknown pid is not a dead pid, so it is never inferred crashed",
    };
  }
  if (opts.pid_alive) return { sweep: false, code: "alive", reason: `holder pid ${rec.pid} is alive — the session is not orphaned` };
  return { sweep: true, reason: `holder pid ${rec.pid} is gone: the record is orphaned (§3.2 sweep)` };
}
