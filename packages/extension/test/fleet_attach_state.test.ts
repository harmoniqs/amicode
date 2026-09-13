// Tests for the extension-side attach-state writer (#780): the single writer
// of ~/.amico/ops/fleet/attach-state.json. The plugin (opencode-plugin/
// stack_state.ts) only READS this file — see test/stack_state.test.ts for the
// rendering contract. Schema (both sides must agree):
//   { hostname, mode: fleet|standalone|degraded, hubName?, hubBaseUrl?,
//     reachable, lastOkAt?, lastRttMs?, since, updatedAt }
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  postureTransition,
  writeAttachState,
  readAttachState,
  recordStandalonePosture,
  type FleetAttachState,
} from "../src/fleet_attach_state";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const T0 = Date.parse("2026-09-03T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function fleetState(overrides: Partial<FleetAttachState> = {}): FleetAttachState {
  return {
    hostname: "macbook",
    mode: "fleet",
    hubName: "erlich",
    hubBaseUrl: "http://127.0.0.1:4096",
    reachable: true,
    lastOkAt: iso(T0 - 5000),
    lastRttMs: 3,
    since: iso(T0 - 5000),
    updatedAt: iso(T0 - 5000),
    ...overrides,
  };
}

describe("postureTransition (transition-only write decision)", () => {
  it("unknown → up: attach transition, mode fleet, reachable, rtt recorded", () => {
    const { changed, state } = postureTransition(undefined, { up: true, rttMs: 7 }, T0, {
      name: "erlich",
      baseUrl: "http://127.0.0.1:4096",
    }, "macbook");
    expect(changed).toBe(true);
    expect(state?.mode).toBe("fleet");
    expect(state?.reachable).toBe(true);
    expect(state?.hostname).toBe("macbook");
    expect(state?.hubName).toBe("erlich");
    expect(state?.hubBaseUrl).toBe("http://127.0.0.1:4096");
    expect(state?.lastOkAt).toBe(iso(T0));
    expect(state?.lastRttMs).toBe(7);
    expect(state?.since).toBe(iso(T0));
    expect(state?.updatedAt).toBe(iso(T0));
  });

  it("unknown → down: hub-lost transition, mode degraded, no lastOk", () => {
    const { changed, state } = postureTransition(undefined, { up: false }, T0, {});
    expect(changed).toBe(true);
    expect(state?.mode).toBe("degraded");
    expect(state?.reachable).toBe(false);
    expect(state?.lastOkAt).toBeUndefined();
  });

  it("fleet → down: degrade transition preserves lastOkAt from the fleet state", () => {
    const prev = fleetState();
    const { changed, state } = postureTransition(prev, { up: false }, T0, {});
    expect(changed).toBe(true);
    expect(state?.mode).toBe("degraded");
    expect(state?.reachable).toBe(false);
    expect(state?.lastOkAt).toBe(prev.lastOkAt);
    expect(state?.since).toBe(iso(T0));
  });

  it("degraded → up: hub-regained transition", () => {
    const prev = fleetState({ mode: "degraded", reachable: false, lastOkAt: iso(T0 - 600_000), since: iso(T0 - 600_000) });
    const { changed, state } = postureTransition(prev, { up: true, rttMs: 5 }, T0, {});
    expect(changed).toBe(true);
    expect(state?.mode).toBe("fleet");
    expect(state?.reachable).toBe(true);
    expect(state?.lastOkAt).toBe(iso(T0));
    expect(state?.since).toBe(iso(T0));
  });

  it("fleet → fleet: NO transition, no write (steady attach is not a tick)", () => {
    const prev = fleetState();
    const { changed, state } = postureTransition(prev, { up: true, rttMs: 9 }, T0, {});
    expect(changed).toBe(false);
    expect(state).toBeUndefined();
  });

  it("degraded → degraded: NO transition, no write", () => {
    const prev = fleetState({ mode: "degraded", reachable: false });
    const { changed, state } = postureTransition(prev, { up: false }, T0, {});
    expect(changed).toBe(false);
    expect(state).toBeUndefined();
  });

  it("a corrupt previous state is treated as unknown (transitions out of it)", () => {
    const a = postureTransition("corrupt", { up: true }, T0, {});
    expect(a.changed).toBe(true);
    expect(a.state?.mode).toBe("fleet");
    const b = postureTransition("corrupt", { up: false }, T0, {});
    expect(b.changed).toBe(true);
    expect(b.state?.mode).toBe("degraded");
  });
});

describe("writeAttachState (atomic single-writer write)", () => {
  it("writes valid JSON with the full schema; no tmp file left behind", () => {
    const dir = mkTmp("attach-state-");
    const p = path.join(dir, "nested", "attach-state.json");
    const state = fleetState();
    writeAttachState(state, p);
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as FleetAttachState;
    expect(raw).toEqual(state);
    expect(fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("readAttachState round-trips what was written", () => {
    const dir = mkTmp("attach-state-");
    const p = path.join(dir, "attach-state.json");
    writeAttachState(fleetState(), p);
    expect(readAttachState(p)).toEqual(fleetState());
  });

  it("readAttachState: missing file → undefined, corrupt file → undefined (never throws)", () => {
    const dir = mkTmp("attach-state-");
    expect(readAttachState(path.join(dir, "absent.json"))).toBeUndefined();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(readAttachState(bad)).toBeUndefined();
  });
});

describe("recordStandalonePosture (standalone machines state so explicitly)", () => {
  it("no existing state → writes standalone posture with since=now, reachable=false", () => {
    const dir = mkTmp("attach-state-");
    const p = path.join(dir, "attach-state.json");
    const state = recordStandalonePosture({ path: p, hostname: "macbook", nowMs: T0 });
    expect(state.mode).toBe("standalone");
    expect(state.reachable).toBe(false);
    expect(state.hostname).toBe("macbook");
    expect(state.since).toBe(iso(T0));
    expect(state.updatedAt).toBe(iso(T0));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("existing standalone state → preserves the original since (fallback time), refreshes updatedAt", () => {
    const dir = mkTmp("attach-state-");
    const p = path.join(dir, "attach-state.json");
    writeAttachState(fleetState({ mode: "standalone", reachable: false, since: iso(T0 - 86_400_000) }), p);
    const state = recordStandalonePosture({ path: p, hostname: "macbook", nowMs: T0 });
    expect(state.mode).toBe("standalone");
    expect(state.since).toBe(iso(T0 - 86_400_000));
    expect(state.updatedAt).toBe(iso(T0));
  });

  it("existing fleet/degraded state (Go Standalone) → transitions to standalone with since=now", () => {
    const dir = mkTmp("attach-state-");
    const p = path.join(dir, "attach-state.json");
    writeAttachState(fleetState({ mode: "degraded", reachable: false, since: iso(T0 - 60_000) }), p);
    const state = recordStandalonePosture({ path: p, hostname: "macbook", nowMs: T0 });
    expect(state.mode).toBe("standalone");
    expect(state.since).toBe(iso(T0));
    expect(state.reachable).toBe(false);
  });

  it("carries hub identity when the (possibly stale) fleet config names one", () => {
    const dir = mkTmp("attach-state-");
    const state = recordStandalonePosture({
      path: path.join(dir, "attach-state.json"),
      hostname: "macbook",
      nowMs: T0,
      hub: { name: "erlich", baseUrl: "http://127.0.0.1:4096" },
    });
    expect(state.hubName).toBe("erlich");
    expect(state.hubBaseUrl).toBe("http://127.0.0.1:4096");
  });
});
