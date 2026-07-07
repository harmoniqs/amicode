import { describe, it, expect } from "vitest";
import {
  DeviceRegistry,
  parseStateJson,
  serializeStateJson,
  parseHistoryLine,
  historyLine,
  type CalibrationEvent,
} from "../src/device_registry";

// Spec A §4.2 + corrections C6/C7: node state on disk is `state.json` (JSON map,
// latest value per node) + `history.jsonl` (append log). This registry is PURE
// in-memory (the run_registry.ts precedent) — file I/O lives in the poll loop /
// manager (the real run_registry ↔ runs_manager split). §6 crit 6: replaying a
// finished-job event keyed on job_id → zero change to state.json.

const ev = (node: string, job_id: string, ts: string, extra: Partial<CalibrationEvent> = {}): CalibrationEvent => ({
  node,
  job_id,
  ts,
  status: "calibrated",
  value: {},
  ...extra,
});

describe("state.json / history.jsonl grammar (never-throw)", () => {
  it("parses a state.json map into NodeState entries", () => {
    const map = parseStateJson(
      JSON.stringify({
        pi_amp: { value: { pi_amp: 0.031 }, ts: "2026-07-06T21:00:00Z", status: "calibrated", job_id: "JOB-42", config_version: "CFG-HW-3" },
      }),
    );
    expect(map.pi_amp).toMatchObject({ ts: "2026-07-06T21:00:00Z", status: "calibrated", job_id: "JOB-42", config_version: "CFG-HW-3" });
    expect((map.pi_amp.value as { pi_amp: number }).pi_amp).toBe(0.031);
  });
  it("degrades to {} on junk / missing (never throws)", () => {
    expect(parseStateJson("not json")).toEqual({});
    expect(parseStateJson(undefined)).toEqual({});
    expect(parseStateJson("[1,2,3]")).toEqual({}); // not an object map
  });
  it("parses a history.jsonl line; rejects blank/torn lines (heals on next drain)", () => {
    const line = historyLine(ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z", { value: { pi_amp: 0.031 } }));
    const back = parseHistoryLine(line);
    expect(back).toMatchObject({ node: "pi_amp", job_id: "JOB-1", status: "calibrated" });
    expect(parseHistoryLine("")).toBeUndefined();
    expect(parseHistoryLine("   ")).toBeUndefined();
    expect(parseHistoryLine('{"node":"pi_amp"')).toBeUndefined(); // torn final line
    expect(parseHistoryLine('{"ts":"x"}')).toBeUndefined(); // no node/job_id
  });
});

describe("DeviceRegistry", () => {
  it("record is idempotent by job_id — replaying a finished-job event is a no-op (§6 crit 6)", () => {
    const reg = new DeviceRegistry();
    const e = ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z", { value: { pi_amp: 0.031 } });
    expect(reg.record(e)).toBe(true);
    const before = reg.snapshot();
    expect(reg.record(e)).toBe(false); // replay = no change
    expect(reg.snapshot()).toBe(before); // state.json unchanged, byte-for-byte
    expect(reg.latest("pi_amp")?.job_id).toBe("JOB-1");
  });

  it("latest returns the newest recorded state; a new job for a node supersedes", () => {
    const reg = new DeviceRegistry();
    reg.record(ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z", { value: { pi_amp: 0.031 } }));
    expect(reg.record(ev("pi_amp", "JOB-2", "2026-07-06T22:00:00Z", { value: { pi_amp: 0.029 } }))).toBe(true);
    expect(reg.latest("pi_amp")?.job_id).toBe("JOB-2");
    expect((reg.latest("pi_amp")?.value as { pi_amp: number }).pi_amp).toBe(0.029);
  });

  it("hydrates from a parsed state.json and round-trips through serialize/parse", () => {
    const reg = new DeviceRegistry();
    reg.record(ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z"));
    reg.record(ev("T1", "JOB-2", "2026-07-06T21:05:00Z", { value: { T1: 55.0 } }));
    const text = reg.snapshot();
    const reg2 = new DeviceRegistry(parseStateJson(text));
    expect(reg2.latest("T1")?.job_id).toBe("JOB-2");
    expect(reg2.toStateMap()).toEqual(reg.toStateMap());
    // a re-hydrated registry still dedups a replayed event (job_id carried in state)
    expect(reg2.record(ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z"))).toBe(false);
    expect(serializeStateJson(reg2.toStateMap())).toBe(text);
  });

  it("toStateMap yields exactly the Record<string, NodeState> evaluate() consumes", () => {
    const reg = new DeviceRegistry();
    reg.record(ev("pi_amp", "JOB-1", "2026-07-06T21:00:00Z", { status: "calibrated" }));
    const map = reg.toStateMap();
    expect(Object.keys(map)).toEqual(["pi_amp"]);
    expect(map.pi_amp.status).toBe("calibrated");
    // returns a COPY — callers can't mutate registry state
    (map.pi_amp as { status: string }).status = "failed";
    expect(reg.latest("pi_amp")?.status).toBe("calibrated");
  });
});
