// `amico fleet` — the registry's CLI surface (fleet spec §3.2/§3.3).
//
// The two properties this suite exists to defend:
//   1. THE WRITE VERBS DO NOT WRITE THE RECORD. `steer`/`stop`/`re-tier` enqueue a signal
//      file and leave the record byte-identical; the harness applies it on its next tick.
//      That is the single-writer discipline, and it is the only reason a CLI may operate a
//      fleet of live sessions at all.
//   2. `sweep` — the one exception that writes — IS PID-LIVENESS GUARDED. A live holder pid
//      is never marked crashed. Neither is an unknown pid (0) nor a foreign-host record:
//      unknowable is not dead.
// Run: pnpm --filter @amicode/amico-run test fleet_verb
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fleetVerb } from "../src/fleet_verb.js";
import {
  listSignals,
  normalizeRecord,
  readRecord,
  recordPath,
  toToml,
  writeRecord,
  type FleetRecord,
  type FleetState,
} from "../src/fleet_registry.js";

const OPUS5 = "anthropic/claude-opus-5";
const SONNET5 = "anthropic/claude-sonnet-5";
const HAIKU = "anthropic/claude-haiku-4-5";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-verb-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A dead-but-real pid: spawn a process that exits immediately, then reuse its pid. More
 *  honest than a made-up number, which could belong to something. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid ?? 999999;
}

function record(session_id: string, state: FleetState, over: Partial<FleetRecord> = {}): FleetRecord {
  return normalizeRecord({
    session_id,
    state,
    started: "2026-07-25T04:00:00.000Z",
    pid: process.pid,
    host: hostname(),
    tokens: 1200,
    runtime: 90,
    current_step: "s1",
    profile: {
      name: "researcher",
      base: "executor",
      model: OPUS5,
      variant: "high",
      task_type: "plan",
      skills: ["amico-vault"],
      gates: ["schema-validate"],
      permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny" },
    },
    ...over,
  });
}

function put(session_id: string, state: FleetState, over: Partial<FleetRecord> = {}): FleetRecord {
  const rec = record(session_id, state, over);
  writeRecord(root, rec);
  return rec;
}

function run(args: string[]): { json: Record<string, unknown>; code: number } {
  const r = fleetVerb([...args, "--root", root]) as { json: Record<string, unknown>; code: number };
  return r;
}

// ── list / status (read verbs) ────────────────────────────────────────────────────
describe("amico fleet list", () => {
  it("renders the derived view for every record, with per-state counts", () => {
    put("sess-a1", "running");
    put("sess-b2", "blocked");
    put("sess-c3", "killed", { pid: 0, respooled_to: "sess-d4" });
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "fleet", subcommand: "list", ok: true, root, count: 3, total: 3 });
    expect(r.json.states).toMatchObject({ running: 1, blocked: 1, killed: 1, spooling: 0, settled: 0, crashed: 0 });
    const sessions = r.json.sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.session_id)).toEqual(["sess-a1", "sess-b2", "sess-c3"]);
    expect(sessions[0]).toMatchObject({
      state: "running",
      terminal: false,
      holder: "harness",
      pid_alive: true,
      host_local: true,
      tokens: 1200,
      runtime: 90,
      current_step: "s1",
      pending_signals: 0,
    });
    expect(sessions[0].legal_events).toEqual(["crash", "block", "settle", "stop", "respool"]);
    expect(sessions[0].available_actions).toEqual(["steer", "stop", "re-tier"]);
    // A killed record is terminal: no actions, no legal events.
    expect(sessions[2]).toMatchObject({ terminal: true, respooled_to: "sess-d4" });
    expect(sessions[2].legal_events).toEqual([]);
    expect(sessions[2].available_actions).toEqual([]);
  });

  it("an empty (or missing) registry root lists nothing and is not an error", () => {
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, count: 0, total: 0 });
    expect(r.json.sessions).toEqual([]);
  });

  it("--state filters, and an unknown state is errors-as-data (exit 64)", () => {
    put("sess-a1", "running");
    put("sess-b2", "blocked");
    const ok = run(["list", "--state", "blocked"]);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ count: 1, total: 2, filter_state: "blocked" });

    const bad = run(["list", "--state", "zombie"]);
    expect(bad.code).toBe(64);
    expect(bad.json).toMatchObject({ verb: "fleet", subcommand: "list", ok: false });
    expect((bad.json.errors as string[]).join(" ")).toMatch(/--state "zombie" must be one of/);
  });

  it("an unreadable record is reported as data, and the readable ones still list", () => {
    put("sess-a1", "running");
    writeFileSync(recordPath(root, "sess-bad"), "broken = = =\n");
    const r = run(["list"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ count: 1 });
    const unreadable = r.json.unreadable as Array<Record<string, unknown>>;
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].session_id).toBe("sess-bad");
    expect((unreadable[0].errors as string[]).join(" ")).toMatch(/TOML parse error/);
  });

  it("--json is accepted and is a no-op — these verbs are JSON-out by construction", () => {
    put("sess-a1", "running");
    const withFlag = run(["list", "--json"]);
    const without = run(["list"]);
    expect(withFlag.code).toBe(0);
    expect(JSON.stringify(withFlag.json.sessions)).toBe(JSON.stringify(without.json.sessions));
  });
});

describe("amico fleet status", () => {
  it("returns the record's derived view plus its permissions, pending signals, and signal dir", () => {
    put("sess-a1", "running");
    const r = run(["status", "--session", "sess-a1"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      verb: "fleet",
      subcommand: "status",
      ok: true,
      session_id: "sess-a1",
      state: "running",
      holder: "harness",
      path: recordPath(root, "sess-a1"),
    });
    expect(r.json.permissions).toMatchObject({ vault: "rw", device: "none", task: "deny" });
    expect(r.json.signals).toEqual([]);
    expect(r.json.signal_dir).toBe(join(root, "sess-a1.signal.d"));
    expect((r.json.profile as Record<string, unknown>).model).toBe(OPUS5);
  });

  it("--session is required; a missing session reports missing:true; both are exit 64", () => {
    const noFlag = run(["status"]);
    expect(noFlag.code).toBe(64);
    expect((noFlag.json.errors as string[]).join(" ")).toMatch(/--session <id> is required/);

    const missing = run(["status", "--session", "sess-nope"]);
    expect(missing.code).toBe(64);
    expect(missing.json).toMatchObject({ ok: false, missing: true, session_id: "sess-nope" });
  });

  it("lists a session's pending signals after an enqueue", () => {
    put("sess-a1", "running");
    run(["steer", "--session", "sess-a1", "--message", "focus on the T1 fit"]);
    const r = run(["status", "--session", "sess-a1"]);
    const signals = r.json.signals as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(1);
    expect((signals[0].signal as Record<string, unknown>).message).toBe("focus on the T1 fit");
    expect(r.json.pending_signals).toBe(1);
  });
});

// ── the write verbs never touch the record ───────────────────────────────────────
describe("amico fleet steer|stop|re-tier — signal enqueue NEVER mutates the record", () => {
  it("steer leaves the record byte-identical and writes exactly one signal file", () => {
    const rec = put("sess-a1", "running");
    const before = readFileSync(recordPath(root, "sess-a1"), "utf8");
    const r = run(["steer", "--session", "sess-a1", "--message", "re-run the fit at reps = 500"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "fleet", subcommand: "steer", ok: true, record_written: false, state: "running" });
    expect(readFileSync(recordPath(root, "sess-a1"), "utf8")).toBe(before);
    expect(before).toBe(toToml(rec));
    const pending = listSignals(root, "sess-a1");
    expect(pending).toHaveLength(1);
    expect(pending[0].signal).toMatchObject({
      signal: "steer",
      session_id: "sess-a1",
      message: "re-run the fit at reps = 500",
      event: "",
      projected_state: "",
      rearms_budget: false,
    });
  });

  it("stop on a live state enqueues the `stop` event and leaves the record alone", () => {
    put("sess-a1", "running");
    const before = readFileSync(recordPath(root, "sess-a1"), "utf8");
    const r = run(["stop", "--session", "sess-a1", "--reason", "deadline"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, record_written: false, applied_by: "harness" });
    expect(readFileSync(recordPath(root, "sess-a1"), "utf8")).toBe(before);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ signal: "stop", event: "stop", projected_state: "killed", message: "deadline" });
    // respooled_to is never on a stop signal — only the harness stamps it, and only on a respool.
    expect(Object.keys(sig)).not.toContain("respooled_to");
  });

  it("stop during triage enqueues the `cancel` event, applied by the EXTENSION (pre-handoff writer)", () => {
    put("sess-a1", "spooling", { pid: process.pid });
    const r = run(["stop", "--session", "sess-a1"]);
    expect(r.code).toBe(0);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ signal: "stop", event: "cancel", projected_state: "killed", applied_by: "extension" });
    expect(r.json.applied_by).toBe("extension");
  });

  it("steering a BLOCKED session enqueues `unblock` and flags the replan-budget re-arm (§5.3)", () => {
    put("sess-a1", "blocked");
    const r = run(["steer", "--session", "sess-a1", "--message", "premise holds, continue"]);
    expect(r.code).toBe(0);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ event: "unblock", projected_state: "running", rearms_budget: true });
    expect(sig.reason).toMatch(/RE-ARMS the replan budget/);
  });

  it("steering a SETTLED session enqueues `resume`", () => {
    put("sess-a1", "settled");
    run(["steer", "--session", "sess-a1", "--message", "one more sweep"]);
    expect(listSignals(root, "sess-a1")[0].signal).toMatchObject({ event: "resume", projected_state: "running" });
  });

  it("many enqueues accumulate in order and the record is still untouched", () => {
    put("sess-a1", "running");
    const before = readFileSync(recordPath(root, "sess-a1"), "utf8");
    run(["steer", "--session", "sess-a1", "--message", "one"]);
    run(["re-tier", "--session", "sess-a1", "--model", HAIKU]);
    run(["stop", "--session", "sess-a1"]);
    const pending = listSignals(root, "sess-a1");
    expect(pending.map((p) => p.signal?.signal)).toEqual(["steer", "re-tier", "stop"]);
    expect(readFileSync(recordPath(root, "sess-a1"), "utf8")).toBe(before);
  });
});

// ── the write verbs' errors-as-data ──────────────────────────────────────────────
describe("amico fleet — errors-as-data on the write verbs", () => {
  it("a missing --session, an unsafe id, and a missing record all fail as data (exit 64, no signal written)", () => {
    const noSession = run(["steer", "--message", "x"]);
    expect(noSession.code).toBe(64);
    expect(noSession.json).toMatchObject({ verb: "fleet", subcommand: "steer", ok: false });

    const traversal = run(["stop", "--session", "../../etc/passwd"]);
    expect(traversal.code).toBe(64);
    expect((traversal.json.errors as string[]).join(" ")).toMatch(/not a valid session id/);

    const absent = run(["stop", "--session", "sess-nope"]);
    expect(absent.code).toBe(64);
    expect(absent.json).toMatchObject({ ok: false, missing: true });
  });

  it("steer without --message is rejected before anything is enqueued", () => {
    put("sess-a1", "running");
    const r = run(["steer", "--session", "sess-a1"]);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toMatch(/--message/);
    expect(listSignals(root, "sess-a1")).toEqual([]);
  });

  it("an action illegal in the record's state is refused with the state and its legal events attached", () => {
    put("sess-a1", "killed", { pid: 0 });
    for (const args of [
      ["steer", "--session", "sess-a1", "--message", "x"],
      ["stop", "--session", "sess-a1"],
      ["re-tier", "--session", "sess-a1", "--model", HAIKU],
    ]) {
      const r = run(args);
      expect(r.code, args[0]).toBe(64);
      expect(r.json).toMatchObject({ ok: false, state: "killed" });
      expect(r.json.legal_events).toEqual([]);
      expect((r.json.errors as string[]).join(" ")).toMatch(/terminal/);
    }
    expect(listSignals(root, "sess-a1")).toEqual([]);
  });

  it("steering a crashed session is refused and points at the actions that DO apply", () => {
    put("sess-a1", "crashed", { pid: 0 });
    const r = run(["steer", "--session", "sess-a1", "--message", "x"]);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toMatch(/no live harness/);
    // ...but stop IS available on a crashed record (§3.3: stop to retire it).
    expect(run(["stop", "--session", "sess-a1"]).code).toBe(0);
  });

  it("an unknown subcommand and a bare `fleet` both return usage at exit 64", () => {
    const unknown = fleetVerb(["explode"]);
    expect(unknown.code).toBe(64);
    expect(unknown.json).toMatchObject({ verb: "fleet" });
    expect((unknown.json as Record<string, string>).error).toMatch(/unknown subcommand "explode"/);
    expect((unknown.json as Record<string, string>).usage).toMatch(/amico fleet list/);
    const bare = fleetVerb([]);
    expect(bare.code).toBe(64);
    expect((bare.json as Record<string, string>).error).toMatch(/\(none\)/);
  });
});

// ── re-tier semantics (§3.3) ─────────────────────────────────────────────────────
describe("amico fleet re-tier", () => {
  it("upward on a plan-walking session: no state change, variant CARRIES OVER, applies at the next step boundary", () => {
    put("sess-a1", "running", {
      profile: { ...record("sess-a1", "running").profile, base: "executor", model: SONNET5, variant: "high" },
    });
    const r = run(["re-tier", "--session", "sess-a1", "--model", OPUS5]);
    expect(r.code).toBe(0);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ signal: "re-tier", model: OPUS5, variant: "high", direction: "up", event: "", projected_state: "", replan: false });
    expect(sig.reason).toMatch(/next step-boundary dispatch/);
  });

  it("downward on a plan-walking session is a REPLAN, and says it costs a replan-budget unit", () => {
    put("sess-a1", "running", { profile: { ...record("sess-a1", "running").profile, base: "executor", model: OPUS5 } });
    const r = run(["re-tier", "--session", "sess-a1", "--model", HAIKU]);
    expect(r.code).toBe(0);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ direction: "down", replan: true });
    expect(sig.reason).toMatch(/replan budget/);
  });

  it("on a RESIDENT it is a respool: the projected state is killed, and the record is still not written", () => {
    put("sess-a1", "running", {
      profile: { ...record("sess-a1", "running").profile, name: "default", base: "resident", task_type: "converse" },
    });
    const before = readFileSync(recordPath(root, "sess-a1"), "utf8");
    const r = run(["re-tier", "--session", "sess-a1", "--model", HAIKU, "--variant", "low"]);
    expect(r.code).toBe(0);
    const sig = listSignals(root, "sess-a1")[0].signal!;
    expect(sig).toMatchObject({ event: "respool", projected_state: "killed", model: HAIKU, variant: "low", replan: false });
    expect(sig.reason).toMatch(/respool/);
    // The successor id is the harness's to mint — a signal never carries respooled_to.
    expect(Object.keys(sig)).not.toContain("respooled_to");
    expect(readFileSync(recordPath(root, "sess-a1"), "utf8")).toBe(before);
  });

  it("refuses a missing --model, an off-ladder model, and a no-op re-stamp", () => {
    put("sess-a1", "running");
    const noModel = run(["re-tier", "--session", "sess-a1"]);
    expect(noModel.code).toBe(64);
    expect((noModel.json.errors as string[]).join(" ")).toMatch(/--model/);

    const offLadder = run(["re-tier", "--session", "sess-a1", "--model", "acme/mystery-1"]);
    expect(offLadder.code).toBe(64);
    expect((offLadder.json.errors as string[]).join(" ")).toMatch(/not on the known tier ladder/);

    const noop = run(["re-tier", "--session", "sess-a1", "--model", OPUS5, "--variant", "high"]);
    expect(noop.code).toBe(64);
    expect((noop.json.errors as string[]).join(" ")).toMatch(/already stamped/);
    expect(listSignals(root, "sess-a1")).toEqual([]);
  });

  it("a settled plan-walking session has no next step boundary, so re-tier is refused there", () => {
    put("sess-a1", "settled", { profile: { ...record("sess-a1", "settled").profile, base: "executor" } });
    const r = run(["re-tier", "--session", "sess-a1", "--model", HAIKU]);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toMatch(/no subsequent executors/);
  });

  it("a variant-only re-tier keeps the model and is accepted", () => {
    put("sess-a1", "running");
    const r = run(["re-tier", "--session", "sess-a1", "--model", OPUS5, "--variant", "max"]);
    expect(r.code).toBe(0);
    expect(listSignals(root, "sess-a1")[0].signal).toMatchObject({ model: OPUS5, variant: "max", direction: "lateral" });
  });
});

// ── sweep: the one write, pid-liveness guarded ───────────────────────────────────
describe("amico fleet sweep — the pid-liveness guard", () => {
  it("A LIVE PID IS NOT MARKED CRASHED, and its record is left byte-identical", () => {
    put("sess-live", "running", { pid: process.pid, host: hostname() });
    const before = readFileSync(recordPath(root, "sess-live"), "utf8");
    const r = run(["sweep"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "fleet", subcommand: "sweep", ok: true, scanned: 1, marked_crashed: 0 });
    const skipped = r.json.skipped as Array<Record<string, unknown>>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ session_id: "sess-live", code: "alive" });
    expect(readFileSync(recordPath(root, "sess-live"), "utf8")).toBe(before);
  });

  it("marks an orphaned running record crashed — and zeroes its pid so nothing probes a recycled one", () => {
    const dead = deadPid();
    put("sess-orphan", "running", { pid: dead, host: hostname() });
    const r = run(["sweep"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ marked_crashed: 1 });
    const marked = r.json.marked as Array<Record<string, unknown>>;
    expect(marked[0]).toMatchObject({ session_id: "sess-orphan", from: "running", to: "crashed", pid: dead, written: true });
    const after = run(["status", "--session", "sess-orphan"]);
    expect(after.json).toMatchObject({ state: "crashed", pid: 0 });
  });

  it("marks an orphaned SPOOLING record crashed — a dead extension cannot write its own crash", () => {
    put("sess-spool", "spooling", { pid: deadPid(), host: hostname() });
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ marked_crashed: 1 });
    expect((r.json.marked as Array<Record<string, unknown>>)[0]).toMatchObject({ from: "spooling", to: "crashed" });
  });

  it("pid = 0 is UNKNOWN, not dead — never marked", () => {
    put("sess-nopid", "running", { pid: 0, host: hostname() });
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ marked_crashed: 0 });
    expect((r.json.skipped as Array<Record<string, unknown>>)[0]).toMatchObject({ code: "pid_unknown" });
  });

  it("a record from another host is unknowable, not dead — never marked", () => {
    put("sess-foreign", "running", { pid: deadPid(), host: `${hostname()}-elsewhere` });
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ marked_crashed: 0 });
    expect((r.json.skipped as Array<Record<string, unknown>>)[0]).toMatchObject({ code: "foreign_host" });
  });

  it("an orphaned blocked / settled / crashed record is REPORTED, never laundered into a crash (§3.2 has no such edge)", () => {
    const dead = deadPid();
    put("sess-b", "blocked", { pid: dead, host: hostname() });
    put("sess-s", "settled", { pid: dead, host: hostname() });
    put("sess-c", "crashed", { pid: dead, host: hostname() });
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ scanned: 3, marked_crashed: 0 });
    const codes = (r.json.skipped as Array<Record<string, unknown>>).map((s) => s.code);
    expect(codes).toEqual(["no_crash_edge", "no_crash_edge", "no_crash_edge"]);
  });

  it("a killed record is terminal and never touched", () => {
    put("sess-k", "killed", { pid: 0, respooled_to: "sess-new" });
    const before = readFileSync(recordPath(root, "sess-k"), "utf8");
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ marked_crashed: 0 });
    expect((r.json.skipped as Array<Record<string, unknown>>)[0]).toMatchObject({ code: "terminal" });
    expect(readFileSync(recordPath(root, "sess-k"), "utf8")).toBe(before);
  });

  it("--dry-run reports what it WOULD mark and writes nothing", () => {
    put("sess-orphan", "running", { pid: deadPid(), host: hostname() });
    const before = readFileSync(recordPath(root, "sess-orphan"), "utf8");
    const r = run(["sweep", "--dry-run"]);
    expect(r.json).toMatchObject({ dry_run: true, marked_crashed: 1 });
    expect((r.json.marked as Array<Record<string, unknown>>)[0]).toMatchObject({ written: false });
    expect(readFileSync(recordPath(root, "sess-orphan"), "utf8")).toBe(before);
  });

  it("sweep is idempotent: the second pass sees `crashed` and has no edge to apply", () => {
    put("sess-orphan", "running", { pid: deadPid(), host: hostname() });
    expect(run(["sweep"]).json).toMatchObject({ marked_crashed: 1 });
    const second = run(["sweep"]);
    expect(second.json).toMatchObject({ marked_crashed: 0 });
    expect((second.json.skipped as Array<Record<string, unknown>>)[0]).toMatchObject({ code: "no_crash_edge" });
  });

  it("an unreadable record does not stop the sweep, and is reported as data", () => {
    put("sess-orphan", "running", { pid: deadPid(), host: hostname() });
    writeFileSync(recordPath(root, "sess-bad"), "broken = = =\n");
    const r = run(["sweep"]);
    expect(r.json).toMatchObject({ scanned: 1, marked_crashed: 1 });
    expect((r.json.unreadable as Array<Record<string, unknown>>)[0]).toMatchObject({ session_id: "sess-bad" });
  });

  it("sweep NEVER writes a signal file — signals flow the other way", () => {
    put("sess-orphan", "running", { pid: deadPid(), host: hostname() });
    run(["sweep"]);
    expect(listSignals(root, "sess-orphan")).toEqual([]);
  });
});

// ── launch / finish: the hunt holder's write path (#426) ─────────────────────────
// Hunts (and any wrapper acting as its own harness) enter the registry HERE, not by
// hand-written TOML: `launch` creates the record the wrapper will hold, `finish` is the
// holder's terminal transition. Three properties to defend:
//   1. launch CREATES ONCE — a second launch over an existing record is refused and the
//      file stays byte-identical (single-writer discipline starts at creation).
//   2. finish is HOLDER-GUARDED — only the pid the record names may write the terminal
//      state; everyone else routes through signals or sweep.
//   3. an abandoned running record (holder gone) is SWEEP-ADOPTABLE — that is the whole
//      point: launch with a dead pid, sweep marks it crashed. No more ps-grep.
describe("amico fleet launch — record creation for self-held holders (#426)", () => {
  it("creates a running record stamped pid/host/started, readable back through status", () => {
    const r = run(["launch", "--session", "hunt-abc", "--pid", String(process.pid)]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      verb: "fleet",
      subcommand: "launch",
      ok: true,
      session_id: "hunt-abc",
      state: "running",
      pid: process.pid,
      host: hostname(),
      path: recordPath(root, "hunt-abc"),
      written: true,
    });
    const after = run(["status", "--session", "hunt-abc"]);
    expect(after.code).toBe(0);
    expect(after.json).toMatchObject({
      state: "running",
      holder: "harness",
      pid: process.pid,
      pid_alive: true,
      host: hostname(),
      host_local: true,
    });
    expect(after.json.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("the created file is a schema-conformant record — not a bash-shaped lookalike", () => {
    run(["launch", "--session", "hunt-abc", "--pid", String(process.pid)]);
    const rec = readRecord(root, "hunt-abc");
    expect(rec.ok).toBe(true);
    expect(rec.ok && rec.record).toMatchObject({
      schema: 1,
      session_id: "hunt-abc",
      state: "running",
      pid: process.pid,
      host: hostname(),
      respooled_to: "",
      profile: { name: "hunt", base: "hunt", task_type: "hunt", skills: [], gates: [] },
    });
  });

  it("launch CREATES ONCE: an existing record is refused and left byte-identical", () => {
    run(["launch", "--session", "hunt-abc", "--pid", String(process.pid)]);
    const before = readFileSync(recordPath(root, "hunt-abc"), "utf8");
    const again = run(["launch", "--session", "hunt-abc", "--pid", String(process.pid)]);
    expect(again.code).toBe(64);
    expect(again.json).toMatchObject({ verb: "fleet", subcommand: "launch", ok: false });
    expect((again.json.errors as string[]).join(" ")).toMatch(/already exists/);
    expect(readFileSync(recordPath(root, "hunt-abc"), "utf8")).toBe(before);
  });

  it("--session is required and must be a safe id; --pid is required and must be a positive integer", () => {
    const noSession = run(["launch", "--pid", "123"]);
    expect(noSession.code).toBe(64);
    expect((noSession.json.errors as string[]).join(" ")).toMatch(/--session/);

    const badId = run(["launch", "--session", "../escape", "--pid", "123"]);
    expect(badId.code).toBe(64);
    expect((badId.json.errors as string[]).join(" ")).toMatch(/not a valid session id/);

    const noPid = run(["launch", "--session", "hunt-abc"]);
    expect(noPid.code).toBe(64);
    expect((noPid.json.errors as string[]).join(" ")).toMatch(/--pid/);

    // pid 0 is the "unknown holder" sentinel — an unsweepable record that defeats the
    // adoption path launch exists to build. Refused, never defaulted.
    for (const bad of ["0", "-1", "3.5", "notapid"]) {
      const r = run(["launch", "--session", "hunt-abc", "--pid", bad]);
      expect(r.code, `--pid ${bad}`).toBe(64);
      expect((r.json.errors as string[]).join(" ")).toMatch(/--pid/);
    }
  });

  it("launch does NOT probe pid liveness — a dead-pid record is allowed and sweep adopts it", () => {
    const dead = deadPid();
    const r = run(["launch", "--session", "hunt-orphan", "--pid", String(dead)]);
    expect(r.code).toBe(0);
    // THE retirement of ps-grep: the record says running, the pid is gone, sweep — not
    // the operator — is the authority that marks it crashed.
    const swept = run(["sweep"]);
    expect(swept.json).toMatchObject({ marked_crashed: 1 });
    expect((swept.json.marked as Array<Record<string, unknown>>)[0]).toMatchObject({
      session_id: "hunt-orphan",
      from: "running",
      to: "crashed",
      pid: dead,
    });
    expect(run(["status", "--session", "hunt-orphan"]).json).toMatchObject({ state: "crashed", pid: 0 });
  });
});

describe("amico fleet finish — the holder's terminal write (#426)", () => {
  it("settled: a matching holder settles its record, zeroes the pid, stamps runtime and step", () => {
    put("hunt-abc", "running");
    const r = run(["finish", "--session", "hunt-abc", "--outcome", "settled", "--pid", String(process.pid), "--step", "exit=0"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, session_id: "hunt-abc", from: "running", to: "settled", written: true });
    const after = run(["status", "--session", "hunt-abc"]);
    expect(after.json).toMatchObject({ state: "settled", pid: 0, current_step: "exit=0" });
    // runtime is the accumulated seconds, frozen at the holder's last tick: started is a
    // minute in the past (the fixture stamps 2026-07-25), so runtime must be > 0 now.
    expect(after.json.runtime as number).toBeGreaterThan(0);
  });

  it("crashed: a matching holder crashes its record (the wrapper's timeout/nonzero path)", () => {
    put("hunt-abc", "running");
    const r = run(["finish", "--session", "hunt-abc", "--outcome", "crashed", "--pid", String(process.pid), "--step", "exit=124 timeout"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ from: "running", to: "crashed" });
    expect(run(["status", "--session", "hunt-abc"]).json).toMatchObject({ state: "crashed", pid: 0, current_step: "exit=124 timeout" });
  });

  it("HOLDER-GUARDED: a pid that is not the record's holder is refused, byte-identical", () => {
    put("hunt-abc", "running");
    const before = readFileSync(recordPath(root, "hunt-abc"), "utf8");
    const r = run(["finish", "--session", "hunt-abc", "--outcome", "settled", "--pid", "999999"]);
    expect(r.code).toBe(64);
    expect(r.json).toMatchObject({ verb: "fleet", subcommand: "finish", ok: false });
    expect((r.json.errors as string[]).join(" ")).toMatch(/holder/);
    expect(readFileSync(recordPath(root, "hunt-abc"), "utf8")).toBe(before);
  });

  it("pid = 0 means the holder is unknown — finish refuses and points at sweep, the orphan authority", () => {
    put("hunt-abc", "running", { pid: 0 });
    const r = run(["finish", "--session", "hunt-abc", "--outcome", "settled", "--pid", "123"]);
    expect(r.code).toBe(64);
    expect((r.json.errors as string[]).join(" ")).toMatch(/sweep/);
  });

  it("the state machine stays the authority: finish on a non-running record is refused with its reason", () => {
    for (const [state, over] of [
      ["settled", {}],
      ["crashed", { pid: process.pid }],
      ["killed", { pid: 0 }],
    ] as Array<[FleetState, Partial<FleetRecord>]>) {
      put("hunt-x", state, over);
      const r = run(["finish", "--session", "hunt-x", "--outcome", "settled", "--pid", String(process.pid)]);
      expect(r.code, state).toBe(64);
      expect(r.json).toMatchObject({ ok: false, state });
      expect((r.json.errors as string[]).join(" ")).toMatch(/settle|terminal|crashed/);
      expect(r.json.legal_events).toBeDefined();
    }
  });

  it("--outcome must be settled|crashed; --session/--pid are required; a missing record is missing:true", () => {
    const badOutcome = run(["finish", "--session", "hunt-abc", "--outcome", "exploded", "--pid", "1"]);
    expect(badOutcome.code).toBe(64);
    expect((badOutcome.json.errors as string[]).join(" ")).toMatch(/--outcome/);

    const noOutcome = run(["finish", "--session", "hunt-abc", "--pid", "1"]);
    expect(noOutcome.code).toBe(64);
    expect((noOutcome.json.errors as string[]).join(" ")).toMatch(/--outcome/);

    expect(run(["finish", "--outcome", "settled", "--pid", "1"]).code).toBe(64);
    expect(run(["finish", "--session", "hunt-abc", "--outcome", "settled"]).code).toBe(64);

    const absent = run(["finish", "--session", "hunt-nope", "--outcome", "settled", "--pid", "1"]);
    expect(absent.code).toBe(64);
    expect(absent.json).toMatchObject({ ok: false, missing: true });
  });

  it("finish NEVER enqueues a signal — it is a direct holder write, not an instruction", () => {
    put("hunt-abc", "running");
    run(["finish", "--session", "hunt-abc", "--outcome", "settled", "--pid", String(process.pid)]);
    expect(listSignals(root, "hunt-abc")).toEqual([]);
  });
});

// ── registration ─────────────────────────────────────────────────────────────────
describe("verb registration", () => {
  it("`fleet` is a spine verb alongside `profile`, and every spine verb still has a real body", async () => {
    const { SPINE_VERBS } = await import("../src/verbs.js");
    const names = SPINE_VERBS.map((v) => v.name);
    expect(names).toContain("fleet");
    expect(names).toContain("profile"); // Task 13's verb must survive the registration
    expect(SPINE_VERBS.find((v) => v.name === "fleet")?.stub).toBeUndefined();
  });
});
