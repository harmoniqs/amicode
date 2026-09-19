// Tests for issue #1276 — "Auto-DOWN orchestration — safe (floor/dirty-guard/
// anti-flap) + surfaced" (ADR 0025 P3, invariant 5; part of #1269).
//
// On a SUSTAINED hub-down link Remote-SSH freezes the whole editor, so the
// always-local companion must drop the window to the thin-client lifeboat —
// SAFELY (no reload storm) and VISIBLY (never a silent reroute). This orchestrator
// consumes the #1275 link sensor's posture stream and, on the hub-down class only,
// reopens into the LOCAL posture (the #1267 lifeboat mount), gated by a
// switch-frequency floor + a dirty-editor guard + anti-flap, surfacing the drop.
//
// The trigger is the sensor's OWN classification: hub-down = the merged detector's
// `standalone` state (pointer contains "hub-down"). The detector already applies
// hysteresis (N=3 consecutive no-responses before it emits `standalone`), so a
// standalone posture from the sensor IS "sustained per hysteresis". `degraded`
// (hub-up-but-slow) is a badge, never a trigger.
//
// AC1: sustained hub-down → exactly one reopen into the thin-client posture;
//      mere `degraded` → zero reopens.
// AC2: the transition is SURFACED (never a silent reopen) — the honest message is
//      shown, before the reopen.
// AC3: a switch-frequency floor AND a dirty-editor guard are enforced, and a
//      flapping link produces NO reload storm (≤1 reopen).
// AC4: the reopen targets the LOCAL/thin-client posture (the file:// lifeboat).

import { describe, it, expect } from "vitest";
import {
  AutoDownSwitch,
  isHubDownTrigger,
  AUTO_DOWN_MESSAGE,
  DIRTY_DEFERRAL_MESSAGE,
  DEFAULT_MIN_SWITCH_INTERVAL_MS,
  type AutoDownDeps,
} from "../src/auto_switch";
import { LinkSensor } from "../src/link_sensor";
import type { LinkPosture } from "../src/link_sensor";
import type { FleetPostureState, FleetPostureSnapshot } from "../src/link_sensor";
import { resolveLocalReopenTarget } from "../src/reopen";
import type { HubProbeResult } from "../src/probe";
// the MERGED detector, imported exactly as the sensor imports it — for the
// degraded-stream integration case (a tuned detector reaches `degraded`).
import * as extPosture from "../../extension/src/amicode_service/fleet_posture";

// ── posture builders — the LinkPosture shape the #1275 sensor emits ───────────
const HUB_DOWN_POINTER =
  "hub-down: the hub is unreachable — the base standalone posture is running; fleet data is honestly unavailable and recoverable";

function snapshotFor(state: FleetPostureState, pointer: string | null): FleetPostureSnapshot {
  return {
    state,
    pointer,
    since: "t0",
    no_response_streak: state === "standalone" ? 3 : 0,
    healthy_streak: state === "fleet" ? 1 : 0,
    latency_window: [],
    refetch_epoch: 0,
    transitions: [],
    last_transition: null,
    parity: { version: null, previous_version: null, changed: false },
  };
}
function mkPosture(state: FleetPostureState, pointer: string | null, reachable: boolean): LinkPosture {
  return { state, pointer, reachable, snapshot: snapshotFor(state, pointer) };
}
const down = (): LinkPosture => mkPosture("standalone", HUB_DOWN_POINTER, false);
const degraded = (): LinkPosture => mkPosture("degraded", null, true);
const ok = (): LinkPosture => mkPosture("fleet", null, true);

// ── harness — every seam injected: clock, dirty predicate, surface, openFolder ─
interface Harness {
  sw: AutoDownSwitch;
  opened: Array<{ uri: string; forceNewWindow: boolean }>;
  messages: string[];
  errors: string[];
  log: string[];
  setNow: (v: number) => void;
  setDirty: (v: boolean) => void;
}
function harness(overrides: Partial<AutoDownDeps> = {}): Harness {
  const opened: Array<{ uri: string; forceNewWindow: boolean }> = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const log: string[] = [];
  let t = 0;
  let dirty = false;
  const deps: AutoDownDeps = {
    localPath: "/home/jj/amicode",
    now: () => t,
    isEditorDirty: () => dirty,
    showMessage: (m) => {
      messages.push(m);
      log.push("surface");
    },
    openFolder: (uri, opts) => {
      opened.push({ uri, forceNewWindow: opts.forceNewWindow });
      log.push("open");
    },
    showError: (m) => errors.push(m),
    minSwitchIntervalMs: 60_000,
    ...overrides,
  };
  return {
    sw: new AutoDownSwitch(deps),
    opened,
    messages,
    errors,
    log,
    setNow: (v) => {
      t = v;
    },
    setDirty: (v) => {
      dirty = v;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — sustained hub-down triggers one local reopen; degraded triggers none
// ══════════════════════════════════════════════════════════════════════════════
describe("AutoDownSwitch — the hub-down trigger (AC1)", () => {
  it("the hub-down class is standalone + a 'hub-down' pointer; degraded/fleet are not", () => {
    expect(isHubDownTrigger(down())).toBe(true);
    expect(isHubDownTrigger(degraded())).toBe(false);
    expect(isHubDownTrigger(ok())).toBe(false);
    // a bare standalone with no hub-down pointer is not the class either
    expect(isHubDownTrigger(mkPosture("standalone", null, false))).toBe(false);
  });

  it("a sustained hub-down posture triggers exactly one reopen into the LOCAL posture", async () => {
    const h = harness();
    expect(await h.sw.handle(down())).toBe("reopened");
    // the sensor emits the standalone LEVEL every tick while down — still one reopen
    expect(await h.sw.handle(down())).toBe("suppressed-by-floor");
    expect(await h.sw.handle(down())).toBe("suppressed-by-floor");
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].uri).toBe("file:///home/jj/amicode");
  });

  it("mere `degraded` (hub-up-but-slow) never triggers a reopen — it is a badge, not a drop", async () => {
    const h = harness();
    expect(await h.sw.handle(degraded())).toBe("not-a-trigger");
    expect(await h.sw.handle(degraded())).toBe("not-a-trigger");
    expect(await h.sw.handle(degraded())).toBe("not-a-trigger");
    expect(h.opened).toHaveLength(0);
    expect(h.messages).toHaveLength(0);
  });

  it("a healthy `fleet` posture never triggers a reopen", async () => {
    const h = harness();
    expect(await h.sw.handle(ok())).toBe("not-a-trigger");
    expect(h.opened).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — the transition is SURFACED (never a silent reopen; ADR 0025 invariant 5)
// ══════════════════════════════════════════════════════════════════════════════
describe("AutoDownSwitch — the transition is surfaced (AC2)", () => {
  it("surfaces the honest transition message on the auto-DOWN drop", async () => {
    const h = harness();
    await h.sw.handle(down());
    expect(h.messages).toEqual([AUTO_DOWN_MESSAGE]);
  });

  it("surfaces BEFORE the reopen — never a silent reroute", async () => {
    const h = harness();
    await h.sw.handle(down());
    // the surface is emitted before openFolder fires
    expect(h.log).toEqual(["surface", "open"]);
  });

  it("the message is honest — it promises session-preserved/resumes + local shell, and never claims chat continues", () => {
    expect(AUTO_DOWN_MESSAGE).toContain("lifeboat");
    expect(AUTO_DOWN_MESSAGE).toContain("preserved");
    expect(AUTO_DOWN_MESSAGE).toMatch(/resumes/i);
    expect(AUTO_DOWN_MESSAGE).toMatch(/local shell/i);
    // the honest-claim invariant from the issue's Key Decisions:
    expect(AUTO_DOWN_MESSAGE.toLowerCase()).not.toContain("chat continues");
  });

  it("an unresolvable local target does NOT claim a drop it can't honor, but is still surfaced (never silent) and opens no half-window", async () => {
    const h = harness({ localPath: "" }); // no local folder → the reopen resolves to an error
    const action = await h.sw.handle(down());
    expect(action).toBe("reopen-failed");
    // honest: we never promised "dropping…" we couldn't do
    expect(h.messages).toHaveLength(0);
    // but it is NOT silent — the reopen's own honest error surfaced (invariant 5)
    expect(h.errors).toHaveLength(1);
    expect(h.opened).toHaveLength(0); // never a half-window
  });

  it("a runtime openFolder failure still surfaced the drop AND the honest error (we tried, and said so)", async () => {
    const h = harness({
      localPath: "/home/jj/amicode", // resolvable → we DO claim the drop
      openFolder: () => {
        throw new Error("VS Code refused to open the folder");
      },
    });
    const action = await h.sw.handle(down());
    expect(action).toBe("reopen-failed");
    expect(h.messages).toEqual([AUTO_DOWN_MESSAGE]); // we surfaced the attempt
    expect(h.errors).toHaveLength(1); // and the honest failure
  });

  it("a persistently-broken target does not storm the surface (the floor throttles even a failed attempt)", async () => {
    const h = harness({ localPath: "", minSwitchIntervalMs: 60_000 });
    h.setNow(0);
    expect(await h.sw.handle(down())).toBe("reopen-failed");
    h.setNow(500);
    expect(await h.sw.handle(down())).toBe("suppressed-by-floor");
    expect(h.errors).toHaveLength(1); // one error, not a storm
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — switch-frequency floor + dirty-editor guard + anti-flap (no reload storm)
// ══════════════════════════════════════════════════════════════════════════════
describe("AutoDownSwitch — the switch-frequency floor (AC3)", () => {
  it("the default floor is one minute (a flapping link never storms; a real re-outage still drops)", () => {
    expect(DEFAULT_MIN_SWITCH_INTERVAL_MS).toBe(60_000);
  });

  it("two triggers within the floor → only the first reopens", async () => {
    const h = harness({ minSwitchIntervalMs: 60_000 });
    h.setNow(0);
    expect(await h.sw.handle(down())).toBe("reopened");
    h.setNow(59_999); // still inside the floor
    expect(await h.sw.handle(down())).toBe("suppressed-by-floor");
    expect(h.opened).toHaveLength(1);
  });

  it("a genuine second outage AFTER the floor elapses drops again", async () => {
    const h = harness({ minSwitchIntervalMs: 60_000 });
    h.setNow(0);
    await h.sw.handle(down());
    await h.sw.handle(ok()); // recovered
    h.setNow(60_000); // the floor has elapsed
    expect(await h.sw.handle(down())).toBe("reopened");
    expect(h.opened).toHaveLength(2);
  });
});

describe("AutoDownSwitch — the dirty-editor guard (AC3)", () => {
  it("a dirty editor BLOCKS the auto-reopen (guarded, never yanked from under unsaved work)", async () => {
    const h = harness();
    h.setDirty(true);
    expect(await h.sw.handle(down())).toBe("blocked-dirty");
    expect(h.opened).toHaveLength(0);
  });

  it("the dirty block is surfaced (its own honest deferral message), once per down-episode", async () => {
    const h = harness();
    h.setDirty(true);
    await h.sw.handle(down());
    await h.sw.handle(down()); // still down, still dirty — no second nag
    expect(h.messages).toEqual([DIRTY_DEFERRAL_MESSAGE]);
  });

  it("once the editor is saved, a later hub-down trigger drops (the guard deferred, it did not veto forever)", async () => {
    const h = harness();
    h.setDirty(true);
    expect(await h.sw.handle(down())).toBe("blocked-dirty");
    h.setDirty(false); // the user saved
    expect(await h.sw.handle(down())).toBe("reopened");
    expect(h.opened).toHaveLength(1);
  });
});

describe("AutoDownSwitch — anti-flap: a flapping link produces NO reload storm (AC3)", () => {
  it("a rapid standalone↔fleet flap within the floor causes ≤1 reopen", async () => {
    const h = harness({ minSwitchIntervalMs: 60_000 });
    // down/up/down/up/down — all inside the floor window (clock barely moves)
    const flaps = [down(), ok(), down(), ok(), down(), ok(), down()];
    let ms = 0;
    for (const p of flaps) {
      h.setNow(ms);
      ms += 500; // rapid — the whole storm is 3s, well inside the 60s floor
      await h.sw.handle(p);
    }
    expect(h.opened).toHaveLength(1); // exactly one drop, no storm
  });

  it("the standalone LEVEL emitted every tick while down does not re-drop (only the floor gates, once)", async () => {
    const h = harness({ minSwitchIntervalMs: 60_000 });
    // 20 consecutive standalone ticks (the sensor emits the level each tick)
    let ms = 0;
    for (let i = 0; i < 20; i++) {
      h.setNow(ms);
      ms += 100;
      await h.sw.handle(down());
    }
    expect(h.opened).toHaveLength(1);
    expect(h.messages).toEqual([AUTO_DOWN_MESSAGE]); // surfaced exactly once too
  });

  it("a flapping DIRTY link neither drops nor storms deferral notices", async () => {
    const h = harness({ minSwitchIntervalMs: 60_000 });
    h.setDirty(true);
    const flaps = [down(), ok(), down(), ok(), down()];
    let ms = 0;
    for (const p of flaps) {
      h.setNow(ms);
      ms += 500;
      await h.sw.handle(p);
    }
    expect(h.opened).toHaveLength(0); // never dropped (dirty)
    // one deferral notice per down-episode (the `ok` between resets the episode) → 3 downs
    expect(h.messages.filter((m) => m === DIRTY_DEFERRAL_MESSAGE)).toHaveLength(3);
    expect(h.messages.every((m) => m === DIRTY_DEFERRAL_MESSAGE)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — the reopen targets the LOCAL/thin-client posture (the file:// lifeboat)
//
// UNIT-PROVABLE here: the drop's target IS the local posture (a `file://` folder
// URI == resolveLocalReopenTarget(localPath).uri), never a Remote-SSH authority —
// the thin-client lifeboat where the #1267 FSP surfaces host files. The runtime
// halves — "the session resumes on reconnect" and "the local shell stays
// responsive" — are properties of the reopened window, observed at runtime (noted
// in the return, not asserted here); what is honest to assert is the TARGET and
// the honest surfaced message, which we do.
// ══════════════════════════════════════════════════════════════════════════════
describe("AutoDownSwitch — the reopen targets the local lifeboat (AC4)", () => {
  it("the drop's target is exactly resolveLocalReopenTarget(localPath) — a local file:// posture", async () => {
    const h = harness({ localPath: "/Users/jj/harmoniqs/amicode" });
    await h.sw.handle(down());
    const expected = resolveLocalReopenTarget("/Users/jj/harmoniqs/amicode");
    expect(expected.ok).toBe(true);
    if (expected.ok) {
      expect(expected.direction).toBe("to-local");
      expect(h.opened[0].uri).toBe(expected.uri);
    }
    expect(h.opened[0].uri.startsWith("file://")).toBe(true);
  });

  it("the target is never a Remote-SSH authority (the drop goes to local, not back to the hub)", async () => {
    const h = harness();
    await h.sw.handle(down());
    expect(h.opened[0].uri.startsWith("vscode-remote://")).toBe(false);
  });

  it("the current window is flipped (forceNewWindow defaults false), not a spawned new one", async () => {
    const h = harness();
    await h.sw.handle(down());
    expect(h.opened[0].forceNewWindow).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration — the whole chain through the REAL #1275 link sensor:
// probe → merged detector → posture stream → auto-DOWN orchestrator.
// This proves "sustained PER HYSTERESIS" end-to-end: the sensor only emits
// `standalone` after the detector's N=3 no-responses, and the orchestrator drops
// exactly then — not on the transient first/second no-response.
// ══════════════════════════════════════════════════════════════════════════════
function scriptedProbe(results: HubProbeResult[]): () => Promise<HubProbeResult> {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return Promise.resolve(r);
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
const reachable = (latencyMs: number): HubProbeResult => ({ reachable: true, status: 200, latencyMs });
const unreachable = (reason = "ECONNREFUSED"): HubProbeResult => ({ reachable: false, reason });

describe("AutoDownSwitch — end-to-end through the live #1275 sensor (AC1 + AC4)", () => {
  it("a sustained hub-down (3 consecutive no-responses) drops ONCE into the local lifeboat, surfaced — not on the transient", async () => {
    const opened: string[] = [];
    const messages: string[] = [];
    const sw = new AutoDownSwitch({
      localPath: "/home/jj/amicode",
      now: () => 0,
      isEditorDirty: () => false,
      showMessage: (m) => messages.push(m),
      openFolder: (uri) => {
        opened.push(uri);
      },
    });
    const sensor = new LinkSensor({
      probe: scriptedProbe([unreachable(), unreachable(), unreachable(), unreachable()]),
      onPosture: sw.onPosture,
    });
    await sensor.tick(); // no-response 1 → still fleet
    await flush();
    expect(opened).toHaveLength(0); // the transient must NOT drop the window
    await sensor.tick(); // no-response 2 → still fleet (2 < N)
    await flush();
    expect(opened).toHaveLength(0);
    await sensor.tick(); // no-response 3 → standalone (hub-down) → the drop fires
    await flush();
    expect(opened).toEqual(["file:///home/jj/amicode"]);
    expect(messages).toEqual([AUTO_DOWN_MESSAGE]);
    await sensor.tick(); // still standalone — the floor holds, no storm
    await flush();
    expect(opened).toHaveLength(1);
  });

  it("a `degraded` (hub-up-but-slow) stream through the live sensor never drops the window", async () => {
    const opened: string[] = [];
    // a detector tuned to enter degraded on a small slow window
    const detector = new extPosture.FleetPostureDetector({
      tuning: { degradedLatencyP95Ms: 100, degradedWindowSamples: 3 },
    });
    const sw = new AutoDownSwitch({
      localPath: "/home/jj/amicode",
      now: () => 0,
      isEditorDirty: () => false,
      showMessage: () => {},
      openFolder: (uri) => {
        opened.push(uri);
      },
    });
    const sensor = new LinkSensor({
      detector,
      probe: scriptedProbe([reachable(200), reachable(200), reachable(200), reachable(200)]),
      onPosture: sw.onPosture,
    });
    for (let i = 0; i < 4; i++) {
      const p = await sensor.tick();
      await flush();
      // the sensor does reach degraded — and the orchestrator still never drops
      expect(["fleet", "degraded"]).toContain(p.state);
    }
    expect(opened).toHaveLength(0);
  });
});
