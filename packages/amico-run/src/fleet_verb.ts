// `amico fleet` — the fleet registry's CLI surface (fleet spec §3.2/§3.3). Every fleet
// surface reads through THESE verbs: the dashboard fleet-view widget, in-chat `/fleet`,
// and Amico answering "which of these campaigns should I kill given Thursday's deadline?"
// are three renderings of one deterministic verb, so the fleet layer never has to speak
// and never has two answers.
//
//   amico fleet list --org <org>  → coordination org projection (spec #318 §5): shows every live session the token may see, with user/host/org
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
//   amico fleet launch --session <id> --pid <n>          (#426, the hunt path)
//   amico fleet finish  --session <id> --outcome settled|crashed --pid <n> [--step "<s>"]
//       → THE HOLDER VERBS — how a WRAPPER (ops/hunt.sh) joins the registry instead of
//         being ps-grepped. A wrapper is its own harness: it holds the record from
//         instant zero, so there is no spooling and no signal to enqueue — launch
//         CREATES ONCE (a record that already exists is refused, so creation can never
//         race a second writer), and finish is the holder's TERMINAL write, guarded by
//         pid identity: only the pid the record names may settle or crash it. Everyone
//         else still routes around the discipline — user intent via a signal, orphans
//         via sweep. The machine stays the authority for both edges (`settle`/`crash`
//         apply only to a `running` record). Hunt records carry a hunt-shaped profile
//         (base = "hunt", no model/variant — a hunt has no tier) so the fleet view can
//         tell them from sessions at a glance.
//
// `--json` is accepted on every subcommand and is a no-op: these verbs are JSON-out by
// construction (amico.ts prints `VerbResult.json`), exactly like the other spine verbs.
import { FRONTIER_MODELS, ladderRungs } from "./ledger_dispatch.js";
import { fleetDigest } from "./fleet_digest.js";
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
  normalizeRecord,
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

// ── launch / finish: the holder verbs (#426) ──────────────────────────────────────
/** The two ways a pid may fail the `--pid` contract of the holder verbs: absent, or
 *  not a positive integer. pid 0 is REFUSED, not defaulted — it is the registry's
 *  "unknown holder" sentinel, and an unknown holder can never be sweep-adopted, which
 *  is the entire reason these verbs exist. */
function parseHolderPid(pidRaw: string | undefined): { pid: number } | { errors: string[] } {
  if (pidRaw === undefined) return { errors: ["--pid <n> is required — the holder's own pid, so `fleet sweep` can guard on liveness once the holder is gone"] };
  if (!/^\d+$/.test(pidRaw) || Number(pidRaw) <= 0) {
    return {
      errors: [
        `--pid "${pidRaw}" must be a positive integer — pid 0 is the registry's unknown-holder sentinel (a record that can never be sweep-adopted), so launch/finish refuse to stamp it rather than mint an unsweepable record`,
      ],
    };
  }
  return { pid: Number(pidRaw) };
}

// ── launch (creation, once) ──────────────────────────────────────────────────────
export function fleetLaunch(argv: string[]): VerbResult {
  const root = rootOf(argv);
  const session = flagValue(argv, "--session");
  if (!session) return fail("launch", ["--session <id> is required"], { root });
  if (!isValidSessionId(session)) return fail("launch", [`--session ${JSON.stringify(session)} is not a valid session id`], { root });
  const pidOr = parseHolderPid(flagValue(argv, "--pid"));
  if ("errors" in pidOr) return fail("launch", pidOr.errors, { root, session_id: session });

  // CREATES ONCE. An existing record — readable or not — is never clobbered: creation
  // over an existing file would be a second writer muscling in on a held record.
  const existing = readRecord(root, session);
  if (existing.ok || !existing.missing) {
    return fail("launch", [`a record for ${JSON.stringify(session)} already exists (${existing.path}) — creation is ONCE; re-running a hunt is a NEW session id, and a held record has exactly one writer (§3.2)`], {
      root,
      session_id: session,
      path: existing.path,
      state: existing.ok ? existing.record.state : "",
    });
  }

  // A wrapper is its own harness: it holds the record from instant zero, so the record
  // is born `running` — there is no spooling (no triage precedes it) and no handoff.
  // pid/host are stamped at creation BECAUSE that pair is what makes a dead holder
  // sweep-detectable later. Liveness is deliberately NOT probed here: a pid that is
  // dead at launch is an orphan at birth, and sweep — not this verb — says so.
  const rec = normalizeRecord({
    session_id: session,
    state: "running",
    started: new Date().toISOString(),
    pid: pidOr.pid,
    host: localHost(),
    profile: {
      name: "hunt",
      base: "hunt",
      model: "",
      variant: "",
      task_type: "hunt",
      skills: [],
      gates: [],
      permissions: {},
    },
  });
  const path = writeRecord(root, rec);
  return {
    json: {
      verb: "fleet",
      subcommand: "launch",
      ok: true,
      root,
      session_id: session,
      path,
      state: rec.state,
      pid: rec.pid,
      host: rec.host,
      written: true,
      note: "record CREATED running and held by this pid — finish it yourself (settled/crashed); if you die first, `fleet sweep` adopts it (pid-liveness guarded)",
    },
    code: 0,
  };
}

// ── finish (the holder's terminal write) ─────────────────────────────────────────
export function fleetFinish(argv: string[]): VerbResult {
  const root = rootOf(argv);
  const session = flagValue(argv, "--session");
  if (!session) return fail("finish", ["--session <id> is required"], { root });
  if (!isValidSessionId(session)) return fail("finish", [`--session ${JSON.stringify(session)} is not a valid session id`], { root });
  const outcome = flagValue(argv, "--outcome");
  if (outcome !== "settled" && outcome !== "crashed") {
    return fail("finish", ['--outcome must be "settled" (the hunt concluded normally) or "crashed" (nonzero exit, timeout kill, or signal)'], { root, session_id: session });
  }
  const pidOr = parseHolderPid(flagValue(argv, "--pid"));
  if ("errors" in pidOr) return fail("finish", pidOr.errors, { root, session_id: session });

  const r = readRecord(root, session);
  if (!r.ok) return fail("finish", r.errors, { root, session_id: session, missing: r.missing, path: r.path });
  const rec = r.record;

  // The machine rules on the EDGE first — `settle`/`crash` apply only to a `running`
  // record, and saying so beats speculating about who is asking. Only then does the
  // holder guard speak.
  const event = outcome === "settled" ? "settle" : "crash";
  const edge = step(rec.state, event);
  if (!edge.ok) {
    return fail("finish", [edge.reason], { root, session_id: session, state: rec.state, legal_events: legalEvents(rec.state) });
  }

  // HOLDER-GUARDED. finish is the holder writing its own terminal state — the pid must
  // match the one the record names. Anything else keeps the discipline: a non-holder
  // stop goes through a signal (applied by the holder), an orphan goes through sweep.
  if (rec.pid === 0) {
    return fail("finish", ["this record's holder pid is unknown (pid = 0) — an unknown holder cannot finish it; the orphan authority is `fleet sweep` (§3.2)"], { root, session_id: session, state: rec.state });
  }
  if (rec.pid !== pidOr.pid) {
    return fail("finish", [`--pid ${pidOr.pid} does not match the record's holder pid ${rec.pid} — finish is the HOLDER's terminal write (§3.2 single-writer discipline); a non-holder stop enqueues a signal, an orphan is swept`], {
      root,
      session_id: session,
      state: rec.state,
      holder_pid: rec.pid,
    });
  }

  // The pid is zeroed by the write (a finished holder holds nothing), and runtime is
  // frozen at the holder's last tick: elapsed seconds from `started`, never less than
  // whatever the record already accumulated.
  const started_ms = rec.started === "" ? NaN : Date.parse(rec.started);
  const runtime = Number.isFinite(started_ms) ? Math.max(rec.runtime, Math.round((Date.now() - started_ms) / 1000)) : rec.runtime;
  const applied = applyEvent(rec, event, {
    pid: 0,
    current_step: flagValue(argv, "--step") ?? rec.current_step,
    runtime,
  });
  if (!applied.ok) {
    // Unreachable while `step()` gates on the same table above, but the machine stays
    // the single authority — finish never writes a state the table did not produce.
    return fail("finish", applied.errors, { root, session_id: session, state: rec.state, legal_events: legalEvents(rec.state) });
  }
  const path = writeRecord(root, applied.record);
  return {
    json: {
      verb: "fleet",
      subcommand: "finish",
      ok: true,
      root,
      session_id: session,
      path,
      from: rec.state,
      to: applied.record.state,
      pid: applied.record.pid,
      runtime: applied.record.runtime,
      current_step: applied.record.current_step,
      written: true,
      note: "the holder's terminal write — the record now reads finished; no signal was enqueued (there is no live session to apply one)",
    },
    code: 0,
  };
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
      note: "the only `amico fleet` path that writes a record it does not hold (§3.2), and only for an orphaned holder pid — a live pid, an unknown pid (0), and a foreign-host record are never marked",
    },
    code: 0,
  };
}

// ── subcommand router ────────────────────────────────────────────────────────────
const USAGE =
  "amico fleet list [--state <s>] [--root D]  |  amico fleet status --session <id>  |  " +
  'amico fleet steer --session <id> --message "<instruction>"  |  amico fleet stop --session <id> [--reason "<why>"]  |  ' +
  "amico fleet re-tier --session <id> --model <provider/id> [--variant <v>]  |  amico fleet sweep [--dry-run]  |  " +
  "amico fleet launch --session <id> --pid <n>  |  " +
  'amico fleet finish --session <id> --outcome settled|crashed --pid <n> [--step "<s>"]  |  ' +
  "amico fleet digest [--post <channel>] [--machines a,b] [--jobs-line \"<t>\"] [--dry-run] [--root D]";

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
  if (sub === "launch") return fleetLaunch(rest);
  if (sub === "finish") return fleetFinish(rest);
  if (sub === "digest") return fleetDigest(rest);
  return {
    json: { verb: "fleet", error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`, usage: USAGE },
    code: 64,
  };
}
