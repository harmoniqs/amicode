// `amico fleet` — the fleet registry's CLI surface (fleet spec §3.2/§3.3). Every fleet
// surface reads through THESE verbs: the dashboard fleet-view widget, in-chat `/fleet`,
// and Amico answering "which of these campaigns should I kill given Thursday's deadline?"
// are three renderings of one deterministic verb, so the fleet layer never has to speak
// and never has two answers.
//
//   amico fleet list   [--state <s>] [--root D] [--json]
//   amico fleet status --session <id> [--root D] [--json]
//       → READ verbs: a derived view over the one-file-per-session records, plus each
//         session's pending signal queue and the actions the fleet view may offer it.
//
//   amico fleet steer   --session <id> --message "<instruction>"
//   amico fleet stop    --session <id> [--reason "<why>"]
//   amico fleet re-tier --session <id> --model <provider/id> [--variant <v>]
//       → WRITE verbs that DO NOT WRITE THE RECORD. They enqueue a signal file under
//         `<session_id>.signal.d/` and the session's harness applies it on its next tick.
//         THIS IS THE SINGLE-WRITER DISCIPLINE, and it is the whole reason a CLI can
//         safely operate a fleet of live sessions: at most one writer holds a record at a
//         time (extension while `spooling`, harness after the handoff at `running`), so a
//         second writer — us — would be a race by construction. Each verb still PREFLIGHTS
//         its action through the pure state machine, so an impossible action fails as data
//         here instead of becoming a signal nobody can apply.
//
//   amico fleet sweep  [--root D] [--dry-run]
//       → THE ONE EXCEPTION THAT WRITES (§3.2): marks `crashed` for orphaned sessions
//         whose holder process is gone, GUARDED BY PID LIVENESS. A live pid is never
//         marked; neither is pid = 0 (unknown ≠ dead) nor a record from another host
//         (liveness is unknowable there). Sweep applies the transition through the same
//         pure machine as everyone else, so it cannot invent an edge the table lacks —
//         an orphaned `blocked` record is REPORTED, not laundered into a crash.
//
// `--json` is accepted on every subcommand and is a no-op: these verbs are JSON-out by
// construction (amico.ts prints `VerbResult.json`), exactly like the other spine verbs.
import { FRONTIER_MODELS, ladderRungs } from "./ledger_dispatch.js";
import {
  applyEvent,
  enqueueSignal,
  fleetRoot,
  isFleetState,
  isPidAlive,
  isTerminal,
  isValidSessionId,
  legalEvents,
  listSignals,
  localHost,
  readAllRecords,
  readRecord,
  recordHolder,
  retierEventFor,
  signalDirPath,
  steerEventFor,
  step,
  stopEventFor,
  sweepVerdict,
  writeRecord,
  type FleetAction,
  type FleetRecord,
  type FleetSignal,
  type FleetState,
  FLEET_RECORD_SCHEMA,
  FLEET_STATES,
} from "./fleet_registry.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function rootOf(argv: string[]): string {
  return fleetRoot(flagValue(argv, "--root"));
}

function fail(subcommand: string, errors: string[], extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "fleet", subcommand, ok: false, errors, ...extra }, code: 64 };
}

// ── the derived view (§3.3's fleet-view row) ──────────────────────────────────────
/** What the fleet view renders for one session: the record, the liveness answer, the
 *  legal §3.2 events, and which of the three per-session actions are offerable. Derived
 *  on read and stored nowhere — the record holds state, this holds the view of it. */
function sessionView(root: string, rec: FleetRecord, host: string): Record<string, unknown> {
  const alive = isPidAlive(rec.pid);
  const pending = listSignals(root, rec.session_id);
  const started_ms = rec.started === "" ? NaN : Date.parse(rec.started);
  const actions: FleetAction[] = [];
  if (steerEventFor(rec.state).ok) actions.push("steer");
  if (stopEventFor(rec.state).ok) actions.push("stop");
  if (retierEventFor(rec.state, rec.profile.base).ok) actions.push("re-tier");
  return {
    session_id: rec.session_id,
    state: rec.state,
    terminal: isTerminal(rec.state),
    holder: recordHolder(rec.state),
    pid: rec.pid,
    pid_alive: alive,
    host: rec.host,
    host_local: rec.host === "" ? false : rec.host === host,
    current_step: rec.current_step,
    started: rec.started,
    since_started_s: Number.isFinite(started_ms) ? Math.max(0, Math.round((Date.now() - started_ms) / 1000)) : 0,
    tokens: rec.tokens,
    runtime: rec.runtime,
    respooled_to: rec.respooled_to,
    profile: {
      name: rec.profile.name,
      base: rec.profile.base,
      model: rec.profile.model,
      variant: rec.profile.variant,
      task_type: rec.profile.task_type,
      skills: rec.profile.skills,
      gates: rec.profile.gates,
    },
    legal_events: legalEvents(rec.state),
    available_actions: actions,
    pending_signals: pending.length,
  };
}

// ── list ─────────────────────────────────────────────────────────────────────────
export function fleetList(argv: string[]): VerbResult {
  const root = rootOf(argv);
  const wanted = flagValue(argv, "--state");
  if (wanted !== undefined && !isFleetState(wanted)) {
    return fail("list", [`--state "${wanted}" must be one of (${FLEET_STATES.join(", ")})`], { root });
  }
  const { records, unreadable } = readAllRecords(root);
  const host = localHost();
  const counts: Record<string, number> = {};
  for (const s of FLEET_STATES) counts[s] = 0;
  for (const r of records) counts[r.state] += 1;
  const shown = wanted === undefined ? records : records.filter((r) => r.state === wanted);
  return {
    json: {
      verb: "fleet",
      subcommand: "list",
      ok: true,
      root,
      host,
      count: shown.length,
      total: records.length,
      states: counts,
      filter_state: wanted ?? "",
      sessions: shown.map((r) => sessionView(root, r, host)),
      unreadable,
    },
    code: 0,
  };
}

// ── status ───────────────────────────────────────────────────────────────────────
export function fleetStatus(argv: string[]): VerbResult {
  const root = rootOf(argv);
  const session = flagValue(argv, "--session");
  if (!session) return fail("status", ["--session <id> is required"], { root });
  const r = readRecord(root, session);
  if (!r.ok) return fail("status", r.errors, { root, session_id: session, missing: r.missing, path: r.path });
  const host = localHost();
  return {
    json: {
      verb: "fleet",
      subcommand: "status",
      ok: true,
      root,
      path: r.path,
      ...sessionView(root, r.record, host),
      permissions: r.record.profile.permissions,
      signals: listSignals(root, session),
      signal_dir: signalDirPath(root, session),
      warnings: r.warnings,
    },
    code: 0,
  };
}

// ── the shared enqueue path for the three write verbs ─────────────────────────────
/** Build + write the signal. The record is READ (to preflight the action against the pure
 *  machine) and never written: `enqueueSignal` only ever touches
 *  `<session_id>.signal.d/`. */
function enqueue(
  subcommand: FleetAction,
  argv: string[],
  build: (rec: FleetRecord) => { sig: Omit<FleetSignal, "schema" | "signal" | "session_id" | "enqueued" | "enqueued_by_pid"> } | { errors: string[] },
): VerbResult {
  const root = rootOf(argv);
  const session = flagValue(argv, "--session");
  if (!session) return fail(subcommand, ["--session <id> is required"], { root });
  if (!isValidSessionId(session)) return fail(subcommand, [`--session ${JSON.stringify(session)} is not a valid session id`], { root });
  const r = readRecord(root, session);
  if (!r.ok) return fail(subcommand, r.errors, { root, session_id: session, missing: r.missing, path: r.path });

  const built = build(r.record);
  if ("errors" in built) {
    return fail(subcommand, built.errors, { root, session_id: session, state: r.record.state, legal_events: legalEvents(r.record.state) });
  }

  const sig: FleetSignal = {
    schema: FLEET_RECORD_SCHEMA,
    signal: subcommand,
    session_id: session,
    enqueued: new Date().toISOString(),
    enqueued_by_pid: process.pid,
    ...built.sig,
  };
  const path = enqueueSignal(root, sig);
  return {
    json: {
      verb: "fleet",
      subcommand,
      ok: true,
      root,
      session_id: session,
      state: r.record.state,
      enqueued: path,
      signal: sig,
      applied_by: sig.applied_by,
      record_written: false,
      note: "signal ENQUEUED, record untouched — the holder applies it on its next tick (§3.2 single-writer discipline)",
    },
    code: 0,
  };
}

/** The projected state after an event, for the signal's `projected_state` field. "" when
 *  the action changes no state. */
function project(rec: FleetRecord, event: FleetSignal["event"]): { state: FleetState | ""; applied_by: FleetSignal["applied_by"]; rearms: boolean } {
  if (event === "") return { state: "", applied_by: recordHolder(rec.state), rearms: false };
  const t = step(rec.state, event);
  if (!t.ok) return { state: "", applied_by: "", rearms: false };
  return { state: t.to, applied_by: t.applied_by[0], rearms: t.rearms_budget };
}

// ── steer ────────────────────────────────────────────────────────────────────────
export function fleetSteer(argv: string[]): VerbResult {
  const message = flagValue(argv, "--message");
  return enqueue("steer", argv, (rec) => {
    if (message === undefined || message.trim() === "") return { errors: ['--message "<instruction>" is required — steer sends an instruction into the session (§3.3)'] };
    const m = steerEventFor(rec.state);
    if (!m.ok) return { errors: [m.reason] };
    const p = project(rec, m.event);
    return {
      sig: {
        event: m.event,
        projected_state: p.state,
        applied_by: p.applied_by,
        message,
        model: "",
        variant: "",
        direction: "",
        replan: false,
        rearms_budget: p.rearms,
        reason: m.reason,
      },
    };
  });
}

// ── stop ─────────────────────────────────────────────────────────────────────────
export function fleetStop(argv: string[]): VerbResult {
  const reason = flagValue(argv, "--reason") ?? "";
  return enqueue("stop", argv, (rec) => {
    const m = stopEventFor(rec.state);
    if (!m.ok) return { errors: [m.reason] };
    const p = project(rec, m.event);
    return {
      sig: {
        event: m.event,
        projected_state: p.state,
        applied_by: p.applied_by,
        message: reason,
        model: "",
        variant: "",
        direction: "",
        replan: false,
        rearms_budget: false,
        // `respooled_to` is deliberately NOT on a stop signal: it is stamped only on a
        // respool-kill, which is how the fleet view tells a retired session from a
        // re-tiered one (§3.2).
        reason: m.reason,
      },
    };
  });
}

// ── re-tier ──────────────────────────────────────────────────────────────────────
/** The stamp's rung on the §6.2 escalation ladder. Frontier-class models that are not the
 *  ladder's own top rung (fable/mythos-class) share the top index — they are the same
 *  TIER, so a swap between them is lateral, not a promotion. -1 = unknown model. */
function rungIndex(model: string): number {
  const rungs = ladderRungs();
  const i = rungs.indexOf(model);
  if (i >= 0) return i;
  return (FRONTIER_MODELS as readonly string[]).includes(model) ? rungs.length - 1 : -1;
}

export function fleetRetier(argv: string[]): VerbResult {
  const model = flagValue(argv, "--model");
  const variant = flagValue(argv, "--variant");
  return enqueue("re-tier", argv, (rec) => {
    if (!model) return { errors: ["--model <provider/model-id> is required — re-tier changes the tier stamp (§3.3)"] };
    const m = retierEventFor(rec.state, rec.profile.base);
    if (!m.ok) return { errors: [m.reason] };

    // Variant CARRIES OVER when not given (§3.3), and model+variant stay co-stamped (§2).
    const nextVariant = variant ?? rec.profile.variant;
    if (model === rec.profile.model && nextVariant === rec.profile.variant) {
      return { errors: [`the session is already stamped ${model} / ${nextVariant} — nothing to re-tier`] };
    }
    const from = rungIndex(rec.profile.model);
    const to = rungIndex(model);
    if (to < 0) {
      return {
        errors: [
          `--model "${model}" is not on the known tier ladder (${ladderRungs().join(" < ")}; frontier-class: ${FRONTIER_MODELS.join(", ")}) — re-tier direction would be undecidable, and §3.3's upward-only rule needs a rung`,
        ],
      };
    }
    if (from < 0) {
      return {
        errors: [
          `the session's current stamp "${rec.profile.model}" is not on the known tier ladder, so the re-tier direction is undecidable — resolve the profile first (\`amico profile resolve\`)`,
        ],
      };
    }
    const direction = to > from ? "up" : to < from ? "down" : "lateral";
    // A DOWNWARD re-tier of a plan-walking session is a REPLAN, not a stamp change: step
    // bodies were written for the stronger reader (§5.1), so the planner must rewrite them
    // for the cheaper one, consuming one unit of the plan's replan budget (§3.3).
    const isResident = rec.profile.base === "resident";
    const replan = direction === "down" && !isResident;
    const p = project(rec, m.event);
    return {
      sig: {
        event: m.event,
        projected_state: p.state,
        applied_by: p.applied_by,
        message: "",
        model,
        variant: nextVariant,
        direction,
        replan,
        rearms_budget: p.rearms,
        reason: replan
          ? `${m.reason}; DOWNWARD on a plan-walking session, so this is a replan rather than a stamp change and costs one unit of the plan's replan budget (§3.3/§5.3)`
          : m.reason,
      },
    };
  });
}

// ── sweep (the one write) ────────────────────────────────────────────────────────
export function fleetSweep(argv: string[]): VerbResult {
  const root = rootOf(argv);
  const dryRun = argv.includes("--dry-run");
  const { records, unreadable } = readAllRecords(root);
  const host = localHost();

  const marked: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const rec of records) {
    // The probe is only consulted when the verdict actually needs it — a terminal or
    // edge-less record is never probed at all.
    const needsProbe = !isTerminal(rec.state) && step(rec.state, "crash").ok && rec.pid !== 0 && (rec.host === "" || rec.host === host);
    const v = sweepVerdict(rec, { local_host: host, pid_alive: needsProbe ? isPidAlive(rec.pid) : false });
    if (!v.sweep) {
      skipped.push({ session_id: rec.session_id, state: rec.state, pid: rec.pid, host: rec.host, code: v.code, reason: v.reason });
      continue;
    }
    const applied = applyEvent(rec, "crash");
    if (!applied.ok) {
      // Unreachable while sweepVerdict gates on the same table, but the machine stays the
      // single authority: sweep never writes a state the table did not produce.
      skipped.push({ session_id: rec.session_id, state: rec.state, pid: rec.pid, host: rec.host, code: "no_crash_edge", reason: applied.errors.join("; ") });
      continue;
    }
    if (!dryRun) writeRecord(root, applied.record);
    marked.push({
      session_id: rec.session_id,
      from: rec.state,
      to: applied.record.state,
      pid: rec.pid,
      host: rec.host,
      reason: v.reason,
      written: !dryRun,
    });
  }

  return {
    json: {
      verb: "fleet",
      subcommand: "sweep",
      ok: true,
      root,
      host,
      dry_run: dryRun,
      scanned: records.length,
      marked_crashed: marked.length,
      marked,
      skipped,
      unreadable,
      note: "the ONLY `amico fleet` path that writes a record (§3.2), and only for an orphaned holder pid — a live pid, an unknown pid (0), and a foreign-host record are never marked",
    },
    code: 0,
  };
}

// ── subcommand router ────────────────────────────────────────────────────────────
const USAGE =
  "amico fleet list [--state <s>] [--root D]  |  amico fleet status --session <id>  |  " +
  'amico fleet steer --session <id> --message "<instruction>"  |  amico fleet stop --session <id> [--reason "<why>"]  |  ' +
  "amico fleet re-tier --session <id> --model <provider/id> [--variant <v>]  |  amico fleet sweep [--dry-run]";

/** The `fleet` verb body: route on the subcommand. Backs BOTH the CLI (amico.ts) and the
 *  MCP facade (mcp_serve.ts) — one impl, two transports. */
export function fleetVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") return fleetList(rest);
  if (sub === "status") return fleetStatus(rest);
  if (sub === "steer") return fleetSteer(rest);
  if (sub === "stop") return fleetStop(rest);
  if (sub === "re-tier") return fleetRetier(rest);
  if (sub === "sweep") return fleetSweep(rest);
  return {
    json: { verb: "fleet", error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`, usage: USAGE },
    code: 64,
  };
}
