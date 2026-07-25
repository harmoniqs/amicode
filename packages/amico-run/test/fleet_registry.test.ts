// The fleet registry state machine (fleet spec §3.2) — the §8 CI requirement, literally:
// "the §3.2 state machine as a pure module with exhaustive transition tests; one-file-per-
// session TOML records round-trip".
//
// EXHAUSTIVE means exhaustive: the golden table below is every one of the 6 states × 9
// events, and the suite asserts each cell maps to EXACTLY ONE outcome — a named target
// state or a rejection. The table is written out longhand on purpose: it is the executable
// copy of the spec's transition list, so a future edit to fleet_registry.ts that "helpfully"
// adds an edge fails here instead of silently widening the machine.
// Run: pnpm --filter @amicode/amico-run test fleet_registry
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvent,
  enqueueSignal,
  fleetRoot,
  fromToml,
  isPidAlive,
  isTerminal,
  isValidSessionId,
  legalEvents,
  listSessionIds,
  listSignals,
  normalizeRecord,
  readAllRecords,
  readRecord,
  recordHolder,
  recordPath,
  retierEventFor,
  signalFromToml,
  signalToToml,
  steerEventFor,
  step,
  stopEventFor,
  sweepVerdict,
  toToml,
  validateRecord,
  writeRecord,
  FLEET_EVENTS,
  FLEET_STATES,
  LIVE_STATES,
  type FleetEvent,
  type FleetRecord,
  type FleetState,
} from "../src/fleet_registry.js";

// ── the golden transition table (fleet §3.2 Rev 3) ────────────────────────────────
// A present cell is the target state; an ABSENT cell is a rejection. Nothing else.
const EXPECTED: Record<FleetState, Partial<Record<FleetEvent, FleetState>>> = {
  // triage call issued. The extension holds the record; the harness does not exist yet.
  spooling: { inject: "running", cancel: "killed", crash: "crashed" },
  // session open / step dispatched. The harness holds the record.
  running: { block: "blocked", settle: "settled", crash: "crashed", stop: "killed", respool: "killed" },
  // replan budget exhausted or a blocked-report awaiting a human.
  blocked: { unblock: "running", stop: "killed", respool: "killed" },
  // work concluded normally; session idle.
  settled: { resume: "running", stop: "killed", respool: "killed" },
  // session/executor died abnormally.
  crashed: { resume: "running", stop: "killed", respool: "killed" },
  // TERMINAL — no edges at all.
  killed: {},
};

const LEGAL_EDGES = Object.values(EXPECTED).reduce((n, row) => n + Object.keys(row).length, 0);

function rec(state: FleetState, over: Partial<FleetRecord> = {}): FleetRecord {
  return normalizeRecord({
    session_id: "sess-a1",
    state,
    started: "2026-07-25T04:00:00.000Z",
    pid: 4242,
    host: "test-host",
    tokens: 1200,
    runtime: 90,
    current_step: "s1",
    profile: {
      name: "researcher",
      base: "executor",
      model: "anthropic/claude-opus-5",
      variant: "high",
      task_type: "plan",
      skills: ["amico-vault"],
      gates: ["schema-validate"],
      permissions: { vault: "rw", packages: "ro", ops: "none", work: "rw", device: "none", task: "deny" },
    },
    ...over,
  });
}

// ── 1. exhaustive: every state × every event, exactly one outcome ─────────────────
describe("fleet registry §3.2 — the transition table, exhaustively", () => {
  it(`the golden table has ${LEGAL_EDGES} legal edges and ${FLEET_STATES.length * FLEET_EVENTS.length - LEGAL_EDGES} rejections (6 states × 9 events)`, () => {
    expect(FLEET_STATES).toHaveLength(6);
    expect(FLEET_EVENTS).toHaveLength(9);
    expect(LEGAL_EDGES).toBe(17);
  });

  for (const from of FLEET_STATES) {
    for (const event of FLEET_EVENTS) {
      const to = EXPECTED[from][event];
      it(`${from} --${event}--> ${to ?? "(rejected)"}`, () => {
        const r = step(from, event);
        if (to === undefined) {
          // Exactly one outcome: a rejection, with a reason and the legal alternatives.
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.reason).not.toBe("");
          expect(r.from).toBe(from);
          expect(r.event).toBe(event);
          expect(r.legal_events).toEqual(legalEvents(from));
          expect(r.legal_events).not.toContain(event);
        } else {
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.to).toBe(to);
          expect(FLEET_STATES).toContain(r.to);
          expect(r.applied_by.length).toBeGreaterThan(0);
          expect(r.note).not.toBe("");
        }
      });
    }
  }

  it("step() is total and deterministic — no cell throws, and the same input gives the same outcome", () => {
    for (const from of FLEET_STATES) {
      for (const event of FLEET_EVENTS) {
        const a = step(from, event);
        const b = step(from, event);
        expect(a).toEqual(b);
        expect(typeof a.ok).toBe("boolean");
      }
    }
  });

  it("legalEvents() agrees with the golden table for every state", () => {
    for (const from of FLEET_STATES) {
      expect(legalEvents(from)).toEqual(FLEET_EVENTS.filter((e) => EXPECTED[from][e] !== undefined));
    }
  });
});

// ── 2. the specific rules the spec calls out ─────────────────────────────────────
describe("fleet registry §3.2 — killed is terminal", () => {
  it("rejects all nine events, and every rejection says so", () => {
    expect(legalEvents("killed")).toEqual([]);
    for (const event of FLEET_EVENTS) {
      const r = step("killed", event);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toMatch(/terminal/);
    }
  });

  it("isTerminal is true for killed only — crashed and settled are LIVE states a user can stop or return to", () => {
    expect(isTerminal("killed")).toBe(true);
    for (const s of FLEET_STATES.filter((x) => x !== "killed")) expect(isTerminal(s)).toBe(false);
  });
});

describe("fleet registry §3.3 — stop is available from any live state", () => {
  it("running | blocked | settled | crashed all take `stop` → killed", () => {
    for (const s of LIVE_STATES) {
      const r = step(s, "stop");
      expect(r.ok, `stop must be legal from ${s}`).toBe(true);
      if (r.ok) expect(r.to).toBe("killed");
    }
  });

  it("a stop during triage is the `cancel` EDGE, not `stop` — different applier, same destination", () => {
    // The user action is the same button; the event differs because the WRITER differs.
    const asEvent = step("spooling", "stop");
    expect(asEvent.ok).toBe(false);
    if (!asEvent.ok) expect(asEvent.reason).toMatch(/cancel/);
    const mapped = stopEventFor("spooling");
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.event).toBe("cancel");
      const r = step("spooling", "cancel");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.to).toBe("killed");
    }
  });

  it("stopEventFor maps every state: spooling → cancel, the four live states → stop, killed → rejected", () => {
    const m = stopEventFor("spooling");
    expect(m.ok && m.event).toBe("cancel");
    for (const s of LIVE_STATES) {
      const v = stopEventFor(s);
      expect(v.ok && v.event).toBe("stop");
    }
    expect(stopEventFor("killed").ok).toBe(false);
  });
});

describe("fleet registry §3.2 — the single-writer handoff", () => {
  it("the extension holds a `spooling` record; the harness holds every other state", () => {
    expect(recordHolder("spooling")).toBe("extension");
    for (const s of FLEET_STATES.filter((x) => x !== "spooling")) expect(recordHolder(s)).toBe("harness");
  });

  it("spooling → running is the ONLY handoff edge, and it hands off extension → harness", () => {
    const handoffs: string[] = [];
    for (const from of FLEET_STATES) {
      for (const event of FLEET_EVENTS) {
        const r = step(from, event);
        if (r.ok && r.handoff) handoffs.push(`${from}--${event}`);
      }
    }
    expect(handoffs).toEqual(["spooling--inject"]);
    const inject = step("spooling", "inject");
    expect(inject.ok).toBe(true);
    if (inject.ok) {
      expect(inject.holder_before).toBe("extension");
      expect(inject.holder_after).toBe("harness");
      expect(inject.applied_by).toEqual(["extension"]);
    }
  });

  it("the extension applies its own pre-handoff kills; post-handoff edges are the harness's", () => {
    for (const event of ["cancel", "crash"] as const) {
      const r = step("spooling", event);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.applied_by).toContain("extension");
    }
    for (const s of LIVE_STATES) {
      const r = step(s, "stop");
      if (r.ok) expect(r.applied_by).toEqual(["harness"]);
    }
  });

  it("`sweep` is an applier of `crash` ONLY — the one CLI-side write exception (§3.2)", () => {
    const sweepable: string[] = [];
    for (const from of FLEET_STATES) {
      for (const event of FLEET_EVENTS) {
        const r = step(from, event);
        if (r.ok && r.applied_by.includes("sweep")) sweepable.push(`${from}--${event}`);
      }
    }
    // A dead extension cannot write its own crash either, so spooling is sweepable too.
    expect(sweepable).toEqual(["spooling--crash", "running--crash"]);
  });
});

describe("fleet registry §3.2 — the two re-entry edges and the budget re-arm", () => {
  it("settled → running and crashed → running are `resume`; a crashed session relaunches on its RECORDED profile", () => {
    for (const s of ["settled", "crashed"] as const) {
      const r = step(s, "resume");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.to).toBe("running");
    }
    const crashed = step("crashed", "resume");
    if (crashed.ok) expect(crashed.note).toMatch(/RECORDED PROFILE/);
  });

  it("blocked → running is `unblock` and is the ONLY edge that re-arms the replan budget (§5.3)", () => {
    const rearming: string[] = [];
    for (const from of FLEET_STATES) {
      for (const event of FLEET_EVENTS) {
        const r = step(from, event);
        if (r.ok && r.rearms_budget) rearming.push(`${from}--${event}`);
      }
    }
    expect(rearming).toEqual(["blocked--unblock"]);
  });

  it("there is no `blocked → crashed` or `settled → crashed` edge — a human decision point is never laundered into a crash", () => {
    for (const s of ["blocked", "settled", "crashed"] as const) {
      const r = step(s, "crash");
      expect(r.ok).toBe(false);
    }
  });
});

// ── 3. respooled_to is stamped only on a respool-kill ────────────────────────────
describe("fleet registry §3.2/§3.3 — respooled_to", () => {
  it("`respool` is the only edge that stamps it, from each of the four live states", () => {
    const stamping: string[] = [];
    for (const from of FLEET_STATES) {
      for (const event of FLEET_EVENTS) {
        const r = step(from, event);
        if (r.ok && r.stamps_respooled_to) stamping.push(`${from}--${event}`);
      }
    }
    expect(stamping).toEqual(["running--respool", "blocked--respool", "settled--respool", "crashed--respool"]);
  });

  it("a respool-kill stamps the successor session id; the record stays killed and terminal", () => {
    const r = applyEvent(rec("running"), "respool", { respooled_to: "sess-b2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe("killed");
    expect(r.record.respooled_to).toBe("sess-b2");
    expect(isTerminal(r.record.state)).toBe(true);
    expect(r.transition.stamps_respooled_to).toBe(true);
  });

  it("a PLAIN STOP leaves respooled_to empty — that is how the fleet view tells a retired session from a re-tiered one", () => {
    const r = applyEvent(rec("running"), "stop");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.state).toBe("killed");
    expect(r.record.respooled_to).toBe("");
  });

  it("respool without a successor id is rejected as data", () => {
    const r = applyEvent(rec("running"), "respool");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/requires the successor session id/);
  });

  it("supplying respooled_to on a non-respool edge is rejected — it may not be stamped by the back door", () => {
    for (const event of ["stop", "settle", "block", "crash"] as const) {
      const r = applyEvent(rec("running"), event, { respooled_to: "sess-b2" });
      expect(r.ok, `${event} must reject respooled_to`).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(/ONLY on a respool-kill/);
    }
  });

  it("a respool may not name its own session — a respool opens a NEW session, it is not a rebind", () => {
    const r = applyEvent(rec("running"), "respool", { respooled_to: "sess-a1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/DIFFERENT session/);
  });

  it("a non-killed record carrying respooled_to fails validation", () => {
    const v = validateRecord({ ...rec("running"), respooled_to: "sess-b2" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(" ")).toMatch(/stamped ONLY on a killed-by-respool record/);
  });
});

// ── 4. applyEvent is pure ────────────────────────────────────────────────────────
describe("fleet registry — applyEvent purity", () => {
  it("returns a NEW record and never mutates its input (including the nested profile)", () => {
    const before = rec("running");
    const snapshot = JSON.parse(JSON.stringify(before));
    const r = applyEvent(before, "settle");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(before).toEqual(snapshot);
    expect(r.record).not.toBe(before);
    expect(r.record.profile).not.toBe(before.profile);
    expect(r.record.profile.skills).not.toBe(before.profile.skills);
    r.record.profile.skills.push("mutated");
    expect(before.profile.skills).toEqual(["amico-vault"]);
  });

  it("rejects an illegal event on a record and relays the transition rejection unchanged", () => {
    const rejection = step("settled", "block");
    expect(rejection.ok).toBe(false);
    const r = applyEvent(rec("settled"), "block");
    expect(r.ok).toBe(false);
    if (!r.ok && !rejection.ok) {
      expect(r.transition).toEqual(rejection);
      expect(r.errors).toEqual([rejection.reason]);
    }
  });

  it("zeroes the pid on a terminal or crashed record, so nothing probes a recycled pid", () => {
    for (const [state, event] of [
      ["running", "stop"],
      ["running", "crash"],
      ["spooling", "cancel"],
      ["spooling", "crash"],
    ] as Array<[FleetState, FleetEvent]>) {
      const r = applyEvent(rec(state), event);
      expect(r.ok, `${state}--${event}`).toBe(true);
      if (r.ok) expect(r.record.pid).toBe(0);
    }
  });

  it("stamps the new holder's pid on the handoff and carries it forward otherwise", () => {
    const injected = applyEvent(rec("spooling", { pid: 111 }), "inject", { pid: 222 });
    expect(injected.ok).toBe(true);
    if (injected.ok) expect(injected.record.pid).toBe(222);
    const settled = applyEvent(rec("running", { pid: 222 }), "settle");
    if (settled.ok) expect(settled.record.pid).toBe(222);
  });

  it("folds in the writer's tick fields (current_step / tokens / runtime) without touching state logic", () => {
    const r = applyEvent(rec("running"), "block", { current_step: "s7", tokens: 9000, runtime: 610 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({ state: "blocked", current_step: "s7", tokens: 9000, runtime: 610 });
    expect(r.transition.rearms_budget).toBe(false);
  });

  it("a full lifecycle walks spooling → running → blocked → running → settled → killed", () => {
    let r: FleetRecord = rec("spooling", { pid: 0 });
    for (const [event, expected] of [
      ["inject", "running"],
      ["block", "blocked"],
      ["unblock", "running"],
      ["settle", "settled"],
      ["stop", "killed"],
    ] as Array<[FleetEvent, FleetState]>) {
      const out = applyEvent(r, event, { pid: 333 });
      expect(out.ok, `${r.state}--${event}`).toBe(true);
      if (!out.ok) return;
      expect(out.record.state).toBe(expected);
      r = out.record;
    }
    expect(applyEvent(r, "resume").ok).toBe(false); // terminal
  });
});

// ── 5. TOML record round-trip + the no-null conventions ──────────────────────────
describe("fleet registry — one-file-per-session TOML round-trip", () => {
  it("round-trips a fully-populated record byte-for-byte through toToml → fromToml → toToml", () => {
    const a = rec("running");
    const text = toToml(a);
    const back = fromToml(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.record).toEqual(a);
    expect(toToml(back.record)).toBe(text);
  });

  it("round-trips a record in every one of the six states", () => {
    for (const s of FLEET_STATES) {
      const a = s === "killed" ? rec(s, { respooled_to: "sess-b2", pid: 0 }) : rec(s);
      const back = fromToml(toToml(a));
      expect(back.ok, `${s} must round-trip`).toBe(true);
      if (back.ok) expect(back.record).toEqual(a);
    }
  });

  it("NO TOML NULLS: an all-absent record serializes as empty strings and zeros", () => {
    const bare = normalizeRecord({ session_id: "sess-z9", state: "spooling" });
    expect(bare).toMatchObject({ current_step: "", started: "", respooled_to: "", host: "", tokens: 0, runtime: 0, pid: 0 });
    const text = toToml(bare);
    expect(text).not.toMatch(/null/);
    expect(text).toMatch(/current_step = ""/);
    expect(text).toMatch(/tokens = 0/);
    expect(text).toMatch(/respooled_to = ""/);
    const back = fromToml(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.record).toEqual(bare);
  });

  it("an explicit null anywhere in a record is an ERROR (tomli has no null at all)", () => {
    for (const key of ["current_step", "respooled_to", "host", "started"] as const) {
      const v = validateRecord({ ...rec("running"), [key]: null });
      expect(v.ok, `${key} = null must be rejected`).toBe(false);
      if (!v.ok) expect(v.errors.join(" ")).toMatch(/NO nulls/);
    }
    const nested = validateRecord({ ...rec("running"), profile: { ...rec("running").profile, model: null } });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.errors.join(" ")).toMatch(/profile\.model is null/);
  });

  it("the emitted TOML is canonically ordered — scalars first, then [profile] and [profile.permissions]", () => {
    const text = toToml(rec("running"));
    expect(text.indexOf("session_id")).toBeLessThan(text.indexOf("[profile]"));
    expect(text.indexOf("[profile]")).toBeLessThan(text.indexOf("[profile.permissions]"));
    expect(text.startsWith("schema = 1\n")).toBe(true);
  });

  it("accepts a hand-written BARE TOML datetime for `started` and normalizes it to ISO-8601", () => {
    const text = `schema = 1
session_id = "sess-a1"
state = "running"
current_step = ""
started = 2026-07-25T04:00:00Z
tokens = 0
runtime = 0
respooled_to = ""
pid = 0
host = ""

[profile]
name = "default"
base = "resident"
model = "anthropic/claude-opus-5"
variant = "high"
task_type = "converse"
skills = []
gates = []

[profile.permissions]
work = "rw"
`;
    const back = fromToml(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.record.started).toBe("2026-07-25T04:00:00.000Z");
  });

  it("rejects a bad state, a bad schema, negative counters, and a non-table profile — errors-as-data, never a throw", () => {
    expect(fromToml("state = 'zombie'\nsession_id = 'a'\n").ok).toBe(false);
    const badState = validateRecord({ ...rec("running"), state: "zombie" });
    expect(badState.ok).toBe(false);
    if (!badState.ok) expect(badState.errors.join(" ")).toMatch(/state "zombie" must be one of/);

    const badSchema = validateRecord({ ...rec("running"), schema: 2 });
    expect(badSchema.ok).toBe(false);

    const negative = validateRecord({ ...rec("running"), tokens: -1 });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.errors.join(" ")).toMatch(/tokens must be >= 0/);

    const noProfile = validateRecord({ session_id: "sess-a1", state: "running" });
    expect(noProfile.ok).toBe(false);
    if (!noProfile.ok) expect(noProfile.errors.join(" ")).toMatch(/missing required table "profile"/);
  });

  it("fromToml on garbage returns a parse error rather than throwing", () => {
    const r = fromToml("this is not = = toml [[[");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/TOML parse error/);
  });

  it("warns (but does not fail) when model/variant are not co-stamped — the tier stamp loses effort control silently", () => {
    const v = validateRecord({ ...rec("running"), profile: { ...rec("running").profile, variant: "" } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(" ")).toMatch(/co-stamped/);
  });
});

// ── 6. session-id safety (the record path is <root>/<id>.toml) ───────────────────
describe("fleet registry — session ids must be safe filename stems", () => {
  it("accepts ordinary ids and rejects anything that could escape the root", () => {
    for (const good of ["sess-a1", "2026-07-25T0400.abc", "A_b.c-1"]) expect(isValidSessionId(good), good).toBe(true);
    for (const bad of ["", "../evil", "a/b", ".hidden", "a\0b", "a b", "x".repeat(129)]) {
      expect(isValidSessionId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("readRecord refuses a traversal id without touching the filesystem", () => {
    const r = readRecord("/nonexistent-root", "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(" ")).toMatch(/not a valid session id/);
      expect(r.missing).toBe(false);
    }
  });
});

// ── 7. the pid-liveness probe + the sweep policy (pure half) ─────────────────────
describe("fleet registry — pid liveness and the sweep verdict", () => {
  it("isPidAlive is true for this process and false for a nonsense pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2 ** 31 - 1)).toBe(false);
  });

  it("sweeps an orphaned running record whose holder pid is gone", () => {
    const v = sweepVerdict(rec("running", { pid: 999999, host: "test-host" }), { local_host: "test-host", pid_alive: false });
    expect(v.sweep).toBe(true);
  });

  it("NEVER sweeps: a live pid, an unknown pid (0), a foreign host, a terminal record, or a state with no crash edge", () => {
    const cases: Array<[FleetRecord, { local_host: string; pid_alive: boolean }, string]> = [
      [rec("running", { pid: 4242, host: "test-host" }), { local_host: "test-host", pid_alive: true }, "alive"],
      [rec("running", { pid: 0, host: "test-host" }), { local_host: "test-host", pid_alive: false }, "pid_unknown"],
      [rec("running", { pid: 4242, host: "other-host" }), { local_host: "test-host", pid_alive: false }, "foreign_host"],
      [rec("killed", { pid: 0 }), { local_host: "test-host", pid_alive: false }, "terminal"],
      [rec("blocked", { pid: 999999, host: "test-host" }), { local_host: "test-host", pid_alive: false }, "no_crash_edge"],
      [rec("settled", { pid: 999999, host: "test-host" }), { local_host: "test-host", pid_alive: false }, "no_crash_edge"],
      [rec("crashed", { pid: 999999, host: "test-host" }), { local_host: "test-host", pid_alive: false }, "no_crash_edge"],
    ];
    for (const [r, opts, code] of cases) {
      const v = sweepVerdict(r, opts);
      expect(v.sweep, `${r.state}/${code} must not sweep`).toBe(false);
      if (!v.sweep) expect(v.code).toBe(code);
    }
  });

  it("an orphaned SPOOLING record is sweepable — a dead extension cannot write its own crash", () => {
    const v = sweepVerdict(rec("spooling", { pid: 999999, host: "test-host" }), { local_host: "test-host", pid_alive: false });
    expect(v.sweep).toBe(true);
  });
});

// ── 8. user actions → events (§3.3's three fleet-view actions) ───────────────────
describe("fleet registry §3.3 — steer / re-tier action mapping", () => {
  it("steer: running → no transition, blocked → unblock (budget re-arm), settled → resume", () => {
    const running = steerEventFor("running");
    expect(running.ok && running.event).toBe("");
    const blocked = steerEventFor("blocked");
    expect(blocked.ok && blocked.event).toBe("unblock");
    if (blocked.ok) expect(blocked.reason).toMatch(/RE-ARMS the replan budget/);
    const settled = steerEventFor("settled");
    expect(settled.ok && settled.event).toBe("resume");
  });

  it("steer is refused where there is nothing live to receive an instruction", () => {
    for (const s of ["spooling", "crashed", "killed"] as const) expect(steerEventFor(s).ok, s).toBe(false);
  });

  it("re-tier on a RESIDENT is a respool from every live state", () => {
    for (const s of LIVE_STATES) {
      const m = retierEventFor(s, "resident");
      expect(m.ok, s).toBe(true);
      if (m.ok) expect(m.event).toBe("respool");
    }
  });

  it("re-tier on a PLAN-WALKING session changes no state — the stamp applies at the next step boundary", () => {
    for (const s of ["running", "blocked"] as const) {
      const m = retierEventFor(s, "executor");
      expect(m.ok, s).toBe(true);
      if (m.ok) {
        expect(m.event).toBe("");
        expect(m.reason).toMatch(/next step-boundary dispatch/);
      }
    }
    // No next boundary to apply it at.
    expect(retierEventFor("settled", "executor").ok).toBe(false);
    expect(retierEventFor("crashed", "executor").ok).toBe(false);
  });

  it("re-tier is refused during triage (the triage call IS the stamp) and after a kill", () => {
    for (const base of ["resident", "executor"]) {
      expect(retierEventFor("spooling", base).ok, base).toBe(false);
      expect(retierEventFor("killed", base).ok, base).toBe(false);
    }
  });
});

// ── 9. record I/O against a real (temp) registry root ────────────────────────────
describe("fleet registry — record I/O, rescan/adoption, signal files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fleet-registry-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("fleetRoot honours the explicit override, then $AMICO_FLEET_DIR, then ~/.amico/ops/fleet", () => {
    const prev = process.env.AMICO_FLEET_DIR;
    try {
      delete process.env.AMICO_FLEET_DIR;
      expect(fleetRoot()).toMatch(/\.amico[/\\]ops[/\\]fleet$/);
      process.env.AMICO_FLEET_DIR = "/tmp/env-fleet";
      expect(fleetRoot()).toBe("/tmp/env-fleet");
      expect(fleetRoot("/tmp/explicit")).toBe("/tmp/explicit");
    } finally {
      if (prev === undefined) delete process.env.AMICO_FLEET_DIR;
      else process.env.AMICO_FLEET_DIR = prev;
    }
  });

  it("writes one file per session, atomically, and reads it back identically", () => {
    const a = rec("running");
    const path = writeRecord(root, a);
    expect(path).toBe(recordPath(root, "sess-a1"));
    const back = readRecord(root, "sess-a1");
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.record).toEqual(a);
    // The tmp file used for the atomic rename must not survive as a record.
    expect(listSessionIds(root)).toEqual(["sess-a1"]);
  });

  it("a missing record reports missing:true, distinct from a corrupt one", () => {
    const absent = readRecord(root, "sess-nope");
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.missing).toBe(true);
    writeFileSync(recordPath(root, "sess-bad"), "state = = broken\n");
    const corrupt = readRecord(root, "sess-bad");
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.missing).toBe(false);
  });

  it("rescan ADOPTS every record it finds, never deletes, and reports the unreadable ones as data", () => {
    writeRecord(root, rec("running", { session_id: "sess-a1" }));
    writeRecord(root, rec("blocked", { session_id: "sess-b2" }));
    writeFileSync(recordPath(root, "sess-bad"), "nonsense = = =\n");
    writeFileSync(join(root, "notes.txt"), "ignored");
    mkdirSync(join(root, "sess-a1.signal.d"), { recursive: true });
    const { records, unreadable } = readAllRecords(root);
    expect(records.map((r) => r.session_id)).toEqual(["sess-a1", "sess-b2"]);
    expect(unreadable.map((u) => u.session_id)).toEqual(["sess-bad"]);
    // Nothing was removed.
    expect(readFileSync(recordPath(root, "sess-bad"), "utf8")).toMatch(/nonsense/);
    expect(listSessionIds(root).sort()).toEqual(["sess-a1", "sess-b2", "sess-bad"]);
  });

  it("a missing root is empty, not an error", () => {
    expect(listSessionIds(join(root, "nope"))).toEqual([]);
    expect(readAllRecords(join(root, "nope"))).toEqual({ records: [], unreadable: [] });
  });

  it("signal files round-trip and sort in enqueue order (fixed-width epoch-ms prefix)", () => {
    const base = {
      schema: 1,
      session_id: "sess-a1",
      enqueued: "2026-07-25T04:00:00.000Z",
      enqueued_by_pid: process.pid,
      projected_state: "" as const,
      applied_by: "harness" as const,
      model: "",
      variant: "",
      direction: "",
      replan: false,
      rearms_budget: false,
      reason: "r",
    };
    enqueueSignal(root, { ...base, signal: "steer", event: "", message: "first" }, 1_700_000_000_000);
    enqueueSignal(root, { ...base, signal: "stop", event: "stop", message: "second" }, 1_700_000_000_500);
    const pending = listSignals(root, "sess-a1");
    expect(pending).toHaveLength(2);
    expect(pending[0].signal?.message).toBe("first");
    expect(pending[1].signal?.signal).toBe("stop");
    expect(pending.every((p) => p.errors === undefined)).toBe(true);
    // Enqueueing never touches the record.
    expect(listSessionIds(root)).toEqual([]);
  });

  it("a burst enqueued in the SAME millisecond keeps ARRIVAL order, not alphabetical order", () => {
    // Regression: with an epoch-ms-only prefix, a same-ms tie sorts by the action name, so
    // steer → re-tier → stop came back as re-tier → steer → stop. The fixed-width sequence
    // field is what makes lexicographic order equal enqueue order.
    const base = {
      schema: 1,
      session_id: "sess-a1",
      enqueued: "2026-07-25T04:00:00.000Z",
      enqueued_by_pid: process.pid,
      event: "" as const,
      projected_state: "" as const,
      applied_by: "harness" as const,
      message: "",
      model: "",
      variant: "",
      direction: "",
      replan: false,
      rearms_budget: false,
      reason: "r",
    };
    for (const signal of ["steer", "re-tier", "stop"] as const) enqueueSignal(root, { ...base, signal }, 1_700_000_000_000);
    expect(listSignals(root, "sess-a1").map((p) => p.signal?.signal)).toEqual(["steer", "re-tier", "stop"]);
  });

  it("two signals enqueued in the same millisecond by the same pid do not collide", () => {
    const sig = {
      schema: 1,
      signal: "steer" as const,
      session_id: "sess-a1",
      enqueued: "2026-07-25T04:00:00.000Z",
      enqueued_by_pid: process.pid,
      event: "" as const,
      projected_state: "" as const,
      applied_by: "harness" as const,
      message: "m",
      model: "",
      variant: "",
      direction: "",
      replan: false,
      rearms_budget: false,
      reason: "r",
    };
    const a = enqueueSignal(root, sig, 1_700_000_000_000);
    const b = enqueueSignal(root, sig, 1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(listSignals(root, "sess-a1")).toHaveLength(2);
  });

  it("an unparseable signal file is reported, never dropped", () => {
    mkdirSync(join(root, "sess-a1.signal.d"), { recursive: true });
    writeFileSync(join(root, "sess-a1.signal.d", "0000000000001-1-steer.toml"), "signal = = broken\n");
    const pending = listSignals(root, "sess-a1");
    expect(pending).toHaveLength(1);
    expect(pending[0].errors?.join(" ")).toMatch(/TOML parse error/);
  });

  it("signalFromToml rejects a bad action, a bad session id, and a bad event", () => {
    expect(signalFromToml('signal = "explode"\nsession_id = "sess-a1"\n').ok).toBe(false);
    expect(signalFromToml('signal = "stop"\nsession_id = "../x"\n').ok).toBe(false);
    const badEvent = signalFromToml('signal = "stop"\nsession_id = "sess-a1"\nevent = "detonate"\n');
    expect(badEvent.ok).toBe(false);
    if (!badEvent.ok) expect(badEvent.errors.join(" ")).toMatch(/must be a §3.2 event/);
    const ok = signalFromToml(
      signalToToml({
        schema: 1,
        signal: "stop",
        session_id: "sess-a1",
        enqueued: "2026-07-25T04:00:00.000Z",
        enqueued_by_pid: 7,
        event: "stop",
        projected_state: "killed",
        applied_by: "harness",
        message: "",
        model: "",
        variant: "",
        direction: "",
        replan: false,
        rearms_budget: false,
        reason: "r",
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.signal.projected_state).toBe("killed");
  });

  it("signal TOML carries no nulls either", () => {
    const text = signalToToml({
      schema: 1,
      signal: "steer",
      session_id: "sess-a1",
      enqueued: "2026-07-25T04:00:00.000Z",
      enqueued_by_pid: 7,
      event: "",
      projected_state: "",
      applied_by: "harness",
      message: "go",
      model: "",
      variant: "",
      direction: "",
      replan: false,
      rearms_budget: false,
      reason: "r",
    });
    expect(text).not.toMatch(/null/);
    expect(text).toMatch(/model = ""/);
  });
});
