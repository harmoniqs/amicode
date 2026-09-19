// Tests for issue #1277 — "Prompt-UP to Remote-SSH on sustained recovery (never
// force)" (ADR 0025 P3; part of #1269).
//
// After the hub link recovers, the user should be able to RETURN to Remote-SSH —
// but must never be yanked back by a brief good patch. This orchestrator is the
// SIBLING of #1276's auto-DOWN: it consumes the SAME #1275 link-sensor posture
// stream and, on a SUSTAINED recovery back to `fleet`, PROMPTS to reopen in
// Remote-SSH. It NEVER force-switches — the asymmetry is the whole design (a bad
// link is urgent → auto-DOWN acts; a good link is not → prompt-UP asks).
//
// "Sustained per hysteresis": the merged detector emits `fleet` only after N=3
// consecutive healthy outcomes, so a brief good patch never reaches `fleet` and
// never prompts. Prompt-UP pairs with auto-DOWN: it arms only on the SAME
// hub-down class auto-DOWN drops on (standalone + a "hub-down" pointer), so a
// mere `degraded→fleet` (never dropped) does not prompt.
//
// AC1: sustained recovery presents a prompt to reopen in Remote-SSH (once).
// AC2: the reopen happens ONLY on user acceptance — never automatically; the
//      target is a Remote-SSH authority, never a local file://.
// AC3: a brief or again-flapping recovery does not prompt (hysteresis asserted),
//      and a prompt-frequency floor prevents repeated recovery prompts spamming.

import { describe, it, expect } from "vitest";
import {
  PromptUpSwitch,
  PROMPT_UP_MESSAGE,
  PROMPT_UP_ACTION,
  CANNOT_RESOLVE_MESSAGE,
  DEFAULT_MIN_PROMPT_INTERVAL_MS,
  type PromptUpDeps,
} from "../src/prompt_up";
import { LinkSensor } from "../src/link_sensor";
import type { LinkPosture } from "../src/link_sensor";
import type { FleetPostureState, FleetPostureSnapshot } from "../src/link_sensor";
import type { HubProbeResult } from "../src/probe";

// ── posture builders — the LinkPosture shape the #1275 sensor emits ───────────
const HUB_DOWN_POINTER =
  "hub-down: the hub is unreachable — the base standalone posture is running; fleet data is honestly unavailable and recoverable";

function snapshotFor(state: FleetPostureState, pointer: string | null): FleetPostureSnapshot {
  return {
    state,
    pointer,
    since: "t0",
    no_response_streak: state === "standalone" ? 3 : 0,
    healthy_streak: state === "fleet" ? 3 : 0,
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

// ── harness — every seam injected: clock, prompt, surface, openFolder ─────────
interface Harness {
  sw: PromptUpSwitch;
  opened: Array<{ uri: string; forceNewWindow: boolean }>;
  prompts: Array<{ message: string; action: string }>;
  messages: string[];
  errors: string[];
  log: string[];
  setNow: (v: number) => void;
  setAccept: (v: boolean) => void;
}
function harness(overrides: Partial<PromptUpDeps> = {}): Harness {
  const opened: Array<{ uri: string; forceNewWindow: boolean }> = [];
  const prompts: Array<{ message: string; action: string }> = [];
  const messages: string[] = [];
  const errors: string[] = [];
  const log: string[] = [];
  let t = 0;
  let accept = false;
  const deps: PromptUpDeps = {
    sshAlias: "amico-erlich",
    now: () => t,
    promptUser: (message, action) => {
      prompts.push({ message, action });
      log.push("prompt");
      return Promise.resolve(accept);
    },
    showMessage: (m) => {
      messages.push(m);
      log.push("surface");
    },
    openFolder: (uri, opts) => {
      opened.push({ uri, forceNewWindow: opts.forceNewWindow });
      log.push("open");
    },
    showError: (m) => errors.push(m),
    minPromptIntervalMs: 60_000,
    ...overrides,
  };
  return {
    sw: new PromptUpSwitch(deps),
    opened,
    prompts,
    messages,
    errors,
    log,
    setNow: (v) => {
      t = v;
    },
    setAccept: (v) => {
      accept = v;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — a sustained recovery presents exactly one prompt to reopen in Remote-SSH
// ══════════════════════════════════════════════════════════════════════════════
describe("PromptUpSwitch — the recovery trigger presents a prompt (AC1)", () => {
  it("a recovery (hub-down → fleet) presents exactly one reopen-in-Remote-SSH prompt", async () => {
    const h = harness();
    expect(await h.sw.handle(down())).toBe("not-a-recovery"); // hub-down: arm the latch
    const action = await h.sw.handle(ok()); // recovery back to fleet
    expect(action).toBe("dismissed"); // (accept defaults false — the prompt still showed)
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].message).toBe(PROMPT_UP_MESSAGE);
    expect(h.prompts[0].action).toBe(PROMPT_UP_ACTION);
  });

  it("the prompt names Remote-SSH and is an invitation, never a forced switch", () => {
    expect(PROMPT_UP_MESSAGE).toMatch(/Remote-SSH/i);
    expect(PROMPT_UP_ACTION).toMatch(/Remote-SSH/i);
    // an invitation, not a fait accompli — it must READ like a question/offer
    expect(PROMPT_UP_MESSAGE).toMatch(/\?|reopen/i);
  });

  it("the initial `fleet` posture at startup is NOT a recovery — no prompt", async () => {
    const h = harness();
    expect(await h.sw.handle(ok())).toBe("not-a-recovery");
    expect(await h.sw.handle(ok())).toBe("not-a-recovery");
    expect(h.prompts).toHaveLength(0);
  });

  it("a `fleet`-only stream (no hub-down episode) never prompts (no spurious recovery)", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) await h.sw.handle(ok());
    expect(h.prompts).toHaveLength(0);
  });

  it("recovery from mere `degraded` (never dropped) does NOT prompt — it pairs with auto-DOWN's hub-down drop", async () => {
    const h = harness();
    // degraded is a badge auto-DOWN never dropped on, so there is nothing to
    // return FROM — a degraded→fleet recovery must not offer a reopen.
    expect(await h.sw.handle(degraded())).toBe("not-a-recovery");
    expect(await h.sw.handle(ok())).toBe("not-a-recovery");
    expect(h.prompts).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  it("a bare standalone with no 'hub-down' pointer does not arm the prompt (mirrors auto-DOWN's trigger class)", async () => {
    const h = harness();
    await h.sw.handle(mkPosture("standalone", null, false)); // not the hub-down class
    expect(await h.sw.handle(ok())).toBe("not-a-recovery");
    expect(h.prompts).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — the reopen happens ONLY on user acceptance; never automatically
// ══════════════════════════════════════════════════════════════════════════════
describe("PromptUpSwitch — reopen only on accept, never forced (AC2)", () => {
  it("accept → exactly one reopen into a Remote-SSH target", async () => {
    const h = harness();
    h.setAccept(true);
    await h.sw.handle(down());
    const action = await h.sw.handle(ok());
    expect(action).toBe("reopened");
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].uri).toBe("vscode-remote://ssh-remote+amico-erlich/~");
  });

  it("the reopen target is a Remote-SSH authority — never a local file://", async () => {
    const h = harness();
    h.setAccept(true);
    await h.sw.handle(down());
    await h.sw.handle(ok());
    expect(h.opened[0].uri.startsWith("vscode-remote://ssh-remote+")).toBe(true);
    expect(h.opened[0].uri.startsWith("file://")).toBe(false);
  });

  it("dismiss → ZERO reopens (the prompt was shown; nothing opened)", async () => {
    const h = harness();
    h.setAccept(false);
    await h.sw.handle(down());
    const action = await h.sw.handle(ok());
    expect(action).toBe("dismissed");
    expect(h.prompts).toHaveLength(1);
    expect(h.opened).toHaveLength(0);
  });

  it("the reopen NEVER fires without an accept — a whole never-accepted stream opens nothing", async () => {
    const h = harness(); // accept defaults false
    for (const p of [down(), down(), ok(), down(), ok()]) await h.sw.handle(p);
    expect(h.opened).toHaveLength(0);
  });

  it("the prompt is shown BEFORE the reopen — the accept gates the open", async () => {
    const h = harness();
    h.setAccept(true);
    await h.sw.handle(down());
    await h.sw.handle(ok());
    expect(h.log).toEqual(["prompt", "open"]);
  });

  it("a configured remote path is honored verbatim in the Remote-SSH target", async () => {
    const h = harness({ sshAlias: "hub", remotePath: "/home/jj/amicode" });
    h.setAccept(true);
    await h.sw.handle(down());
    await h.sw.handle(ok());
    expect(h.opened[0].uri).toBe("vscode-remote://ssh-remote+hub/home/jj/amicode");
  });

  it("the reopen flips the CURRENT window (forceNewWindow defaults false) — returning UP, not spawning", async () => {
    const h = harness();
    h.setAccept(true);
    await h.sw.handle(down());
    await h.sw.handle(ok());
    expect(h.opened[0].forceNewWindow).toBe(false);
  });

  it("accept but a runtime openFolder failure → reopen-failed, surfaced honestly (not swallowed)", async () => {
    const h = harness({
      openFolder: () => {
        throw new Error("VS Code refused to open the folder");
      },
    });
    h.setAccept(true);
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("reopen-failed");
    expect(h.errors).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cannot-resolve — a recovery with no Remote-SSH target shows NO half-prompt
// (never a misleading offer we can't honor), but is still surfaced honestly.
// ══════════════════════════════════════════════════════════════════════════════
describe("PromptUpSwitch — an unresolvable target shows no half-prompt (never force, never mislead)", () => {
  it("a recovery with no SSH alias does NOT prompt — it surfaces the honest cannot-resolve notice", async () => {
    const h = harness({ sshAlias: "" }); // no Remote-SSH target resolvable
    await h.sw.handle(down());
    const action = await h.sw.handle(ok());
    expect(action).toBe("cannot-resolve-target");
    expect(h.prompts).toHaveLength(0); // NEVER a half-prompt
    expect(h.messages).toContain(CANNOT_RESOLVE_MESSAGE); // but not silent — surfaced
    expect(h.opened).toHaveLength(0);
  });

  it("a flapping unresolvable recovery does not storm the surface (the floor throttles the notice)", async () => {
    const h = harness({ sshAlias: "", minPromptIntervalMs: 60_000 });
    h.setNow(0);
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("cannot-resolve-target");
    h.setNow(500); // still inside the floor
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("suppressed-by-floor");
    expect(h.messages.filter((m) => m === CANNOT_RESOLVE_MESSAGE)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — a brief / flapping recovery does not prompt (hysteresis) + a
// prompt-frequency floor stops repeated recovery prompts spamming
// ══════════════════════════════════════════════════════════════════════════════
describe("PromptUpSwitch — the prompt-frequency floor (AC3)", () => {
  it("the default floor is one minute (a flapping link never storms; a real re-recovery still prompts)", () => {
    expect(DEFAULT_MIN_PROMPT_INTERVAL_MS).toBe(60_000);
  });

  it("two recoveries within the floor → only the first prompts", async () => {
    const h = harness({ minPromptIntervalMs: 60_000 });
    h.setNow(0);
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("dismissed"); // prompt 1
    h.setNow(59_999); // still inside the floor
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("suppressed-by-floor");
    expect(h.prompts).toHaveLength(1);
  });

  it("a genuine second recovery AFTER the floor elapses prompts again", async () => {
    const h = harness({ minPromptIntervalMs: 60_000 });
    h.setNow(0);
    await h.sw.handle(down());
    await h.sw.handle(ok()); // prompt 1
    h.setNow(60_000); // the floor has elapsed
    await h.sw.handle(down());
    expect(await h.sw.handle(ok())).toBe("dismissed");
    expect(h.prompts).toHaveLength(2);
  });
});

describe("PromptUpSwitch — a flapping recovery does not storm prompts (AC3 hysteresis + floor)", () => {
  it("a rapid standalone↔fleet flap within the floor causes ≤1 prompt", async () => {
    const h = harness({ minPromptIntervalMs: 60_000 });
    const flaps = [down(), ok(), down(), ok(), down(), ok()];
    let ms = 0;
    for (const p of flaps) {
      h.setNow(ms);
      ms += 500; // rapid — the whole storm is inside the 60s floor
      await h.sw.handle(p);
    }
    expect(h.prompts).toHaveLength(1); // exactly one prompt, no storm
    expect(h.opened).toHaveLength(0); // and (accept=false) nothing reopened
  });

  it("the fleet LEVEL repeated after a recovery does not re-prompt (only the transition prompts, once)", async () => {
    const h = harness({ minPromptIntervalMs: 60_000 });
    await h.sw.handle(down());
    await h.sw.handle(ok()); // recovery → prompt 1
    for (let i = 0; i < 20; i++) await h.sw.handle(ok()); // the fleet level every tick
    expect(h.prompts).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration — the whole chain through the REAL #1275 sensor: probe → merged
// detector → posture stream → prompt-UP. This is the honest AC3 "hysteresis
// asserted" proof: the sensor only emits `fleet` after the detector's N=3
// consecutive-healthy recovery streak, so a brief good patch never prompts and a
// sustained one prompts exactly once.
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

describe("PromptUpSwitch — end-to-end through the live #1275 sensor (AC1 + AC3 hysteresis)", () => {
  it("a SUSTAINED recovery (3 consecutive healthy after hub-down) prompts once — a brief 2-tick good patch does NOT", async () => {
    const prompts: number[] = [];
    const opened: string[] = [];
    const sw = new PromptUpSwitch({
      sshAlias: "amico-erlich",
      now: () => 0,
      promptUser: (_m, _a) => {
        prompts.push(1);
        return Promise.resolve(true); // accept
      },
      showMessage: () => {},
      openFolder: (uri) => {
        opened.push(uri);
      },
    });
    const sensor = new LinkSensor({
      probe: scriptedProbe([
        unreachable(),
        unreachable(),
        unreachable(), // → standalone (hub-down)
        reachable(50),
        reachable(50), // a BRIEF good patch — 2 < 3, never reaches fleet
        reachable(50), // the 3rd consecutive healthy → fleet (sustained recovery)
      ]),
      onPosture: sw.onPosture,
    });
    await sensor.tick();
    await sensor.tick();
    await sensor.tick(); // hub-down now
    await flush();
    expect(prompts).toHaveLength(0);
    await sensor.tick();
    await sensor.tick(); // the brief good patch — still standalone per hysteresis
    await flush();
    expect(prompts).toHaveLength(0); // a brief recovery does NOT prompt (AC3)
    await sensor.tick(); // 3rd healthy → fleet → sustained recovery
    await flush();
    expect(prompts).toHaveLength(1); // prompted exactly once (AC1)
    expect(opened).toEqual(["vscode-remote://ssh-remote+amico-erlich/~"]); // accepted → reopened UP
  });

  it("a brief recovery that flaps back to hub-down never reaches fleet → never prompts (hysteresis)", async () => {
    const prompts: number[] = [];
    const sw = new PromptUpSwitch({
      sshAlias: "hub",
      now: () => 0,
      promptUser: (_m, _a) => {
        prompts.push(1);
        return Promise.resolve(false);
      },
      showMessage: () => {},
    });
    const sensor = new LinkSensor({
      probe: scriptedProbe([
        unreachable(),
        unreachable(),
        unreachable(), // standalone
        reachable(50),
        reachable(50), // 2 healthy — brief, never reaches fleet
        unreachable(),
        unreachable(),
        unreachable(), // flaps back down, still standalone
      ]),
      onPosture: sw.onPosture,
    });
    for (let i = 0; i < 8; i++) {
      await sensor.tick();
      await flush();
    }
    expect(prompts).toHaveLength(0);
  });
});
