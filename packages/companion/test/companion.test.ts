// Tests for issue #1274 — "P2: UI-kind always-local companion (extension split)
// — feasibility spike + go/no-go" (ADR 0025 P2, part of #1269).
//
// The companion is a SEPARATE `ui`-kind extension that always runs on the
// client. This suite proves the three UNIT-TESTABLE feasibility halves; the two
// runtime/HITL halves (survives main-extension relocation under live Remote-SSH;
// the final feasible/abort decision) live in the go/no-go artifact, not here.
//
// AC1 (testable half): the companion ACTIVATES client-side — activate() runs,
//   registers its command, and wires its probe + reopen. ("Remains running
//   during live relocation" is HITL — go/no-go doc.)
// AC2: the companion executes a CLIENT-SIDE probe, independent of any host-side
//   instance (it reads only the client-configured hub URL + an injected fetch).
// AC3 (testable half): the companion programmatically triggers a Remote-SSH↔local
//   window reopen — pure URI construction (both directions) + the executeCommand
//   ("vscode.openFolder", …) wiring. (The live reopen is runtime.)

import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { probeHubHealth } from "../src/probe";
import {
  resolveRemoteSshReopenTarget,
  resolveLocalReopenTarget,
  reopenWindow,
} from "../src/reopen";
import { activate, deactivate, REOPEN_COMMAND, COMPANION_HUB_URL_SETTING, COMPANION_HUB_SSH_ALIAS_SETTING } from "../src/companion";
import { DEFAULT_PROBE_CADENCE_MS, type SensorScheduler } from "../src/link_sensor";

// A fake ExtensionContext — the companion touches only `subscriptions`.
function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}

// A fetch double: resolves to a Response-like with the given status, and records
// every URL it was asked to hit (so we can prove the probe targets the
// client-configured URL and nothing host-side).
function fakeFetch(status: number) {
  const hits: string[] = [];
  const fn = ((url: string) => {
    hits.push(String(url));
    return Promise.resolve({ status, json: () => Promise.resolve({}) } as unknown as Response);
  }) as unknown as typeof fetch;
  return { fn, hits };
}
function throwingFetch(message: string) {
  return ((_url: string) => Promise.reject(new Error(message))) as unknown as typeof fetch;
}

beforeEach(() => {
  (vscode.commands as unknown as { _reset(): void })._reset();
  vscode.window.messages.error.length = 0;
  vscode.window.messages.info.length = 0;
  vscode.window.messages.warn.length = 0;
  vscode.window.infoActions.length = 0;
  (vscode.window as unknown as { _infoResponse: string | undefined })._infoResponse = undefined;
  vscode.env.remoteName = undefined;
  (vscode.workspace as unknown as { _config: Record<string, unknown> })._config = {};
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
});

// ── AC2: client-side probe, independent of any host-side instance ────────────
describe("probeHubHealth (AC2 — client-side probe)", () => {
  it("reaches the client-configured hub URL and reports the answer", async () => {
    const f = fakeFetch(200);
    const r = await probeHubHealth("http://127.0.0.1:4096", { fetch: f.fn, now: (() => 0) });
    expect(r.reachable).toBe(true);
    if (r.reachable) expect(r.status).toBe(200);
  });

  it("targets EXACTLY the given base URL + the health path (independent of host state)", async () => {
    const f = fakeFetch(200);
    await probeHubHealth("http://127.0.0.1:4096", { fetch: f.fn });
    // The ONLY thing it touched is the injected fetch, aimed at the client URL —
    // it read no host-side instance, posture file, or projection.
    expect(f.hits).toEqual(["http://127.0.0.1:4096/global/health"]);
  });

  it("honors a custom health path", async () => {
    const f = fakeFetch(204);
    await probeHubHealth("http://h:1/", { fetch: f.fn, healthPath: "/status" });
    expect(f.hits).toEqual(["http://h:1/status"]);
  });

  it("a 5xx is still an answer — reachable true (the host responded)", async () => {
    const f = fakeFetch(503);
    const r = await probeHubHealth("http://h:1", { fetch: f.fn });
    expect(r.reachable).toBe(true);
    if (r.reachable) expect(r.status).toBe(503);
  });

  it("a transport error is unreachable, carrying the reason", async () => {
    const r = await probeHubHealth("http://h:1", { fetch: throwingFetch("ECONNREFUSED") });
    expect(r.reachable).toBe(false);
    if (!r.reachable) expect(r.reason).toContain("ECONNREFUSED");
  });

  it("an unconfigured (empty/undefined) hub URL is the honest no-base-url state — no fetch", async () => {
    const f = fakeFetch(200);
    const r = await probeHubHealth("", { fetch: f.fn });
    expect(r.reachable).toBe(false);
    if (!r.reachable) expect(r.reason).toMatch(/no-base-url|no hub/i);
    const r2 = await probeHubHealth(undefined, { fetch: f.fn });
    expect(r2.reachable).toBe(false);
    expect(f.hits).toEqual([]); // never dialed anything
  });

  it("a malformed base URL is an honest unreachable, not a throw", async () => {
    const r = await probeHubHealth("not a url", { fetch: fakeFetch(200).fn });
    expect(r.reachable).toBe(false);
  });
});

// ── AC3: programmatic Remote-SSH↔local reopen (pure URI construction) ─────────
describe("resolveRemoteSshReopenTarget (AC3 — local → Remote-SSH URI)", () => {
  it("builds the Remote-SSH URI from the alias + the home default path", () => {
    const r = resolveRemoteSshReopenTarget("amico-erlich");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.direction).toBe("to-remote");
      expect(r.uri).toBe("vscode-remote://ssh-remote+amico-erlich/~");
    }
  });

  it("uses a configured absolute path verbatim", () => {
    const r = resolveRemoteSshReopenTarget("hub", "/home/jj/amicode");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.uri).toBe("vscode-remote://ssh-remote+hub/home/jj/amicode");
  });

  it("accepts a home-relative (~) path", () => {
    const r = resolveRemoteSshReopenTarget("hub", "~/amicode");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.uri).toBe("vscode-remote://ssh-remote+hub/~/amicode");
  });

  it("trims the alias (mirrors the main extension's resolveRemoteSshTarget)", () => {
    const r = resolveRemoteSshReopenTarget("  hub  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.uri).toBe("vscode-remote://ssh-remote+hub/~");
  });

  it("a blank alias is a no-ssh-alias reason — never a half-window", () => {
    const r = resolveRemoteSshReopenTarget("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-ssh-alias");
  });

  it("a relative configured path is rejected — never a half-window", () => {
    const r = resolveRemoteSshReopenTarget("hub", "amicode/sub");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid-workspace-path");
      expect(r.detail).toContain("amicode/sub");
    }
  });
});

describe("resolveLocalReopenTarget (AC3 — Remote-SSH → local URI)", () => {
  it("builds a file:// URI from an absolute local path", () => {
    const r = resolveLocalReopenTarget("/home/jj/amicode");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.direction).toBe("to-local");
      expect(r.uri).toBe("file:///home/jj/amicode");
    }
  });

  it("a blank or relative local path is an honest error — never a half-window", () => {
    expect(resolveLocalReopenTarget("").ok).toBe(false);
    expect(resolveLocalReopenTarget("relative/path").ok).toBe(false);
  });
});

describe("reopenWindow (AC3 — the executeCommand('vscode.openFolder') wiring)", () => {
  it("fires the injected openFolder exactly once with the resolved URI + forceNewWindow", async () => {
    const opened: Array<{ uri: string; forceNewWindow: boolean }> = [];
    const res = resolveRemoteSshReopenTarget("hub");
    const out = await reopenWindow(res, {
      openFolder: (uri, opts) => {
        opened.push({ uri, forceNewWindow: opts.forceNewWindow });
      },
    });
    expect(out.ok).toBe(true);
    expect(opened).toEqual([{ uri: "vscode-remote://ssh-remote+hub/~", forceNewWindow: false }]);
  });

  it("passes forceNewWindow through", async () => {
    const opened: Array<{ uri: string; forceNewWindow: boolean }> = [];
    await reopenWindow(resolveRemoteSshReopenTarget("hub"), {
      forceNewWindow: true,
      openFolder: (uri, opts) => opened.push({ uri, forceNewWindow: opts.forceNewWindow }),
    });
    expect(opened[0].forceNewWindow).toBe(true);
  });

  it("the DEFAULT wiring calls executeCommand('vscode.openFolder') exactly once", async () => {
    await reopenWindow(resolveRemoteSshReopenTarget("hub"));
    const openFolderCalls = vscode.commands.executed.filter((c) => c.id === "vscode.openFolder");
    expect(openFolderCalls).toHaveLength(1);
    expect(String((openFolderCalls[0].args[0] as { toString(): string }).toString())).toBe(
      "vscode-remote://ssh-remote+hub/~",
    );
  });

  it("an unresolvable target opens NO window and surfaces the honest message", async () => {
    const opened: string[] = [];
    const errors: string[] = [];
    const out = await reopenWindow(resolveRemoteSshReopenTarget(""), {
      openFolder: (uri) => opened.push(uri),
      showError: (m) => errors.push(m),
    });
    expect(out.ok).toBe(false);
    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

// ── AC1: the companion activates client-side (wires command + probe + reopen) ─
describe("activate (AC1 — client-side activation)", () => {
  it("registers the reopen command and pushes a disposable to subscriptions", () => {
    const ctx = fakeContext();
    activate(ctx as never);
    expect((vscode.commands as unknown as { _registeredIds(): string[] })._registeredIds()).toContain(
      REOPEN_COMMAND,
    );
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns an API that wires the client-side probe (reads the client hubUrl setting)", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096";
    const f = fakeFetch(200);
    const api = activate(fakeContext() as never, { probeFetch: f.fn });
    const r = await api.probeHub();
    expect(r.reachable).toBe(true);
    expect(f.hits).toEqual(["http://127.0.0.1:4096/global/health"]);
  });

  it("the wired reopen flips LOCAL → Remote-SSH when the window is local", async () => {
    const opened: string[] = [];
    vscode.env.remoteName = undefined; // a local window
    const api = activate(fakeContext() as never, { openFolder: (uri) => opened.push(uri) });
    await api.reopen({ alias: "hub" });
    expect(opened).toEqual(["vscode-remote://ssh-remote+hub/~"]);
  });

  it("the wired reopen flips Remote-SSH → LOCAL when the window is remote", async () => {
    const opened: string[] = [];
    vscode.env.remoteName = "ssh-remote"; // a Remote-SSH window
    const api = activate(fakeContext() as never, { openFolder: (uri) => opened.push(uri) });
    await api.reopen({ localPath: "/home/jj/amicode" });
    expect(opened).toEqual(["file:///home/jj/amicode"]);
  });

  it("the registered command handler drives a reopen (executeCommand path)", async () => {
    vscode.env.remoteName = undefined;
    activate(fakeContext() as never);
    await vscode.commands.executeCommand(REOPEN_COMMAND, { alias: "hub" });
    const openFolderCalls = vscode.commands.executed.filter((c) => c.id === "vscode.openFolder");
    expect(openFolderCalls).toHaveLength(1);
  });

  it("deactivate is a safe no-op", () => {
    expect(() => deactivate()).not.toThrow();
  });
});

// ── #1275: activate wires + STARTS the client-side link sensor on the cadence ─
// A timer seam that captures the scheduled callback + cadence instead of using
// real timers.
function fakeScheduler() {
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const scheduler: SensorScheduler = {
    setInterval: (cb, ms) => {
      scheduled.push({ cb, ms });
      return scheduled.length - 1;
    },
    clearInterval: (h) => {
      cleared.push(h);
    },
  };
  return { scheduler, scheduled, cleared };
}

describe("activate (#1275 — the client-side link sensor runs on the standard cadence)", () => {
  it("starts the link sensor on the standard cadence (AC1)", () => {
    const { scheduler, scheduled } = fakeScheduler();
    activate(fakeContext() as never, { scheduler });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(DEFAULT_PROBE_CADENCE_MS);
  });

  it("exposes the sensor; a reachable probe classifies fleet (ok), feeding the bundled detector (AC1)", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096";
    const { scheduler } = fakeScheduler();
    const f = fakeFetch(200);
    const api = activate(fakeContext() as never, { probeFetch: f.fn, scheduler });
    const posture = await api.linkSensor.tick();
    expect(posture.state).toBe("fleet");
    expect(posture.reachable).toBe(true);
    expect(f.hits).toEqual(["http://127.0.0.1:4096/global/health"]);
  });

  it("an unreachable stream classifies hub-down (standalone) through the bundled detector (AC1/AC2)", async () => {
    const { scheduler } = fakeScheduler();
    const api = activate(fakeContext() as never, { probeFetch: throwingFetch("ECONNREFUSED"), scheduler });
    // The hub URL is unset in this test → the probe is the honest no-base-url
    // no-response; N of those enter the hub-down posture.
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    const third = await api.linkSensor.tick();
    expect(third.state).toBe("standalone");
    expect(third.pointer).toContain("hub-down");
  });

  it("dispose() and the subscription both stop the sensor (no dangling cadence)", () => {
    const { scheduler, scheduled, cleared } = fakeScheduler();
    const ctx = fakeContext();
    const api = activate(ctx as never, { scheduler });
    expect(scheduled).toHaveLength(1);
    api.dispose();
    expect(cleared).toHaveLength(1); // the interval was cleared
  });

  it("the sensor stop is registered on context.subscriptions (VS Code-driven teardown)", () => {
    const { scheduler, cleared } = fakeScheduler();
    const ctx = fakeContext();
    activate(ctx as never, { scheduler });
    // dispose every subscription the way VS Code does on deactivate
    for (const d of ctx.subscriptions) d.dispose();
    expect(cleared).toHaveLength(1);
  });
});

// ── #1276: activate wires the auto-DOWN orchestrator onto the sensor stream ────
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("activate (#1276 — the auto-DOWN drop fires through the wired sensor)", () => {
  it("a sustained hub-down through the live sensor drops the window to the LOCAL lifeboat, surfaced (AC1/AC2/AC4)", async () => {
    const { scheduler } = fakeScheduler();
    const opened: string[] = [];
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: throwingFetch("ECONNREFUSED"), // every probe unreachable
      localReopenPath: () => "/home/jj/amicode",
      openFolder: (uri) => opened.push(uri),
      now: () => 0,
    });
    await api.linkSensor.tick(); // no-response 1 → fleet
    await api.linkSensor.tick(); // no-response 2 → fleet (2 < N)
    await flush();
    expect(opened).toHaveLength(0); // not on the transient
    await api.linkSensor.tick(); // no-response 3 → standalone → the drop fires
    await flush();
    expect(opened).toEqual(["file:///home/jj/amicode"]); // the local lifeboat target (AC4)
    expect(vscode.window.messages.warn.length).toBeGreaterThanOrEqual(1); // surfaced (AC2)
  });

  it("a dirty editor blocks the wired drop (AC3 dirty guard, production predicate)", async () => {
    const { scheduler } = fakeScheduler();
    const opened: string[] = [];
    (vscode.workspace as unknown as { textDocuments: Array<{ isDirty: boolean }> }).textDocuments = [
      { isDirty: true },
    ];
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: throwingFetch("ECONNREFUSED"),
      localReopenPath: () => "/home/jj/amicode",
      openFolder: (uri) => opened.push(uri),
      now: () => 0,
    });
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick(); // standalone — but the editor is dirty
    await flush();
    expect(opened).toHaveLength(0); // guarded — no drop under unsaved work
    (vscode.workspace as unknown as { textDocuments: Array<{ isDirty: boolean }> }).textDocuments = [];
  });

  it("exposes the auto-DOWN orchestrator for #1277 (prompt-UP) to extend", () => {
    const { scheduler } = fakeScheduler();
    const api = activate(fakeContext() as never, { scheduler });
    expect(api.autoDown).toBeDefined();
    expect(typeof api.autoDown.onPosture).toBe("function");
  });
});

// ── #1277: activate wires the prompt-UP orchestrator onto the SAME sensor seam ─
// A fetch double whose reachability is flipped mid-stream, so one wired sensor
// drives a full hub-down → sustained-recovery arc through the real merged
// detector: 3 unreachable → hub-down, then 3 reachable → the recovery prompt.
function flippableFetch(state: { reachable: boolean }) {
  return ((_url: string) =>
    state.reachable
      ? Promise.resolve({ status: 200, json: () => Promise.resolve({}) } as unknown as Response)
      : Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
}

describe("activate (#1277 — the prompt-UP offer fires through the wired sensor)", () => {
  it("a sustained recovery after a hub-down prompts to reopen in Remote-SSH; ACCEPT → reopen into the Remote-SSH target", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096";
    (vscode.window as unknown as { _infoResponse: string | undefined })._infoResponse = "Reopen in Remote-SSH"; // accept
    const { scheduler } = fakeScheduler();
    const opened: string[] = [];
    const link = { reachable: false };
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: flippableFetch(link),
      remoteSshAlias: () => "amico-erlich",
      openFolder: (uri) => opened.push(uri),
      now: () => 0,
    });
    // 3 unreachable → the merged detector enters hub-down (standalone)
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    expect(vscode.window.messages.info).toHaveLength(0); // no prompt while still down
    // link recovers — 3 consecutive healthy → fleet (sustained recovery)
    link.reachable = true;
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    expect(vscode.window.messages.info.length).toBeGreaterThanOrEqual(1); // the reopen prompt was shown
    expect(vscode.window.infoActions.some((a) => a.includes("Reopen in Remote-SSH"))).toBe(true);
    // accepted → reopened UP into the Remote-SSH authority (never a local file://)
    expect(opened).toEqual(["vscode-remote://ssh-remote+amico-erlich/~"]);
  });

  it("a sustained-recovery prompt the user DISMISSES reopens NOTHING (never automatic)", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096";
    (vscode.window as unknown as { _infoResponse: string | undefined })._infoResponse = undefined; // dismiss
    const { scheduler } = fakeScheduler();
    const opened: string[] = [];
    const link = { reachable: false };
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: flippableFetch(link),
      remoteSshAlias: () => "hub",
      openFolder: (uri) => opened.push(uri),
      now: () => 0,
    });
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    link.reachable = true;
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    expect(vscode.window.messages.info.length).toBeGreaterThanOrEqual(1); // prompt shown
    expect(opened).toHaveLength(0); // dismissed → nothing reopened (AC2)
  });

  it("reads the hub-ssh-alias setting when no alias getter is injected (a recovery with no alias shows no half-prompt)", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096";
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_SSH_ALIAS_SETTING] = "";
    (vscode.window as unknown as { _infoResponse: string | undefined })._infoResponse = "Reopen in Remote-SSH";
    const { scheduler } = fakeScheduler();
    const opened: string[] = [];
    const link = { reachable: false };
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: flippableFetch(link),
      openFolder: (uri) => opened.push(uri),
      now: () => 0,
    });
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    link.reachable = true;
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await flush();
    expect(vscode.window.messages.info).toHaveLength(0); // no half-prompt without a target
    expect(opened).toHaveLength(0);
    expect(vscode.window.messages.warn.length).toBeGreaterThanOrEqual(1); // the honest cannot-resolve notice
  });

  it("exposes the prompt-UP orchestrator wired to the same posture seam", () => {
    const { scheduler } = fakeScheduler();
    const api = activate(fakeContext() as never, { scheduler });
    expect(api.promptUp).toBeDefined();
    expect(typeof api.promptUp.onPosture).toBe("function");
  });
});

// ── #1278: activate wires the cross-scheme editor-carry into BOTH switches ─────
// The carry seam is injectable through CompanionDeps; here we prove activate()
// forwards it so a wired drop / return actually carries the open host editors
// across the scheme flip (end-to-end through the live merged detector).
describe("activate (#1278 — the editor-carry is wired into both switch handlers)", () => {
  it("a wired auto-DOWN drop carries the open host editors to the lifeboat scheme (amico-host:/)", async () => {
    const { scheduler } = fakeScheduler();
    const carried: string[] = [];
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: throwingFetch("ECONNREFUSED"),
      localReopenPath: () => "/home/jj/amicode",
      openFolder: () => {},
      now: () => 0,
      listOpenEditors: () => ["vscode-remote://ssh-remote+hub/home/jj/a.jl", "file:///tmp/scratch.txt"],
      carryEditor: (uri) => carried.push(uri),
    });
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick(); // sustained hub-down → the drop fires
    await flush();
    // the host editor carried DOWN to amico-host; the local scratch untouched
    expect(carried).toEqual(["amico-host:/home/jj/a.jl"]);
  });

  it("a wired, accepted prompt-UP return carries the open host editors to the Remote-SSH scheme", async () => {
    (vscode.workspace as unknown as { _config: Record<string, unknown> })._config[COMPANION_HUB_URL_SETTING] =
      "http://127.0.0.1:4096"; // the probe must actually dial for a recovery to register
    (vscode.window as unknown as { _infoResponse: string | undefined })._infoResponse = "Reopen in Remote-SSH";
    const { scheduler } = fakeScheduler();
    const carried: string[] = [];
    const link = { reachable: false };
    const api = activate(fakeContext() as never, {
      scheduler,
      probeFetch: flippableFetch(link),
      remoteSshAlias: () => "amico-erlich",
      openFolder: () => {},
      now: () => 0,
      listOpenEditors: () => ["amico-host:/home/jj/a.jl", "file:///tmp/scratch.txt"],
      carryEditor: (uri) => carried.push(uri),
    });
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick(); // hub-down
    await flush();
    link.reachable = true;
    await api.linkSensor.tick();
    await api.linkSensor.tick();
    await api.linkSensor.tick(); // sustained recovery → prompt → accept → reopen UP
    await flush();
    // the host editor carried UP to the ssh authority; the local scratch untouched
    expect(carried).toEqual(["vscode-remote://ssh-remote+amico-erlich/home/jj/a.jl"]);
  });
});

