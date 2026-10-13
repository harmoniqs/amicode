// chat_session_launcher.test.ts — #1764 the shared chat-session launcher.
//
// The launcher opens-or-reveals the chat panel and delivers ONE navigate
// envelope (`/new-session?prompt=…&autoSend=1`) exactly once — immediately when
// the panel's app has signalled ready since its last dispose / frame set,
// otherwise queued for app-ready under a 15 s deadline. Every collaborator is
// injected, so these cases drive it with a fake panel and fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createChatSessionLauncher,
  SERVER_NOT_READY_WARNING,
  CHAT_DID_NOT_LOAD_WARNING,
  LAUNCH_DEADLINE_MS,
  REPEAT_LAUNCH_WINDOW_MS,
} from "../src/chat_session_launcher";
import type { LaunchTarget } from "../src/chat_session_launcher";

type FakePanel = LaunchTarget & {
  ready: boolean;
  disposed: boolean;
  posted: unknown[];
  fireAppReady(): void;
  dispose(): void;
  resetFrame(): void;
  readySubscribers(): number;
};

/** A fake chat panel. Its app-ready subscription is PERSISTENT until the
 *  returned unsubscribe runs — so a second app-ready reaches any subscriber the
 *  launcher left behind, and only the launcher's own guard prevents a resend. */
function fakePanel(ready = false): FakePanel {
  const readyCbs = new Set<() => void>();
  const disposeCbs = new Set<() => void>();
  const p: FakePanel = {
    ready,
    disposed: false,
    posted: [],
    isAppReady: () => p.ready,
    postMessage: (m: unknown) => {
      p.posted.push(m);
    },
    subscribeAppReady: (cb: () => void) => {
      readyCbs.add(cb);
      return () => readyCbs.delete(cb);
    },
    subscribeDispose: (cb: () => void) => {
      disposeCbs.add(cb);
      return () => disposeCbs.delete(cb);
    },
    fireAppReady: () => {
      p.ready = true;
      for (const cb of [...readyCbs]) cb();
    },
    dispose: () => {
      p.ready = false;
      p.disposed = true;
      for (const cb of [...disposeCbs]) cb();
    },
    resetFrame: () => {
      p.ready = false;
    },
    readySubscribers: () => readyCbs.size,
  };
  return p;
}

const nav = (prompt: string) => ({
  source: "amicode",
  kind: "navigate",
  path: `/new-session?prompt=${encodeURIComponent(prompt)}&autoSend=1`,
});

function harness(opts: { serverReady?: boolean } = {}) {
  const state = { serverReady: opts.serverReady ?? true, panel: fakePanel(true) as FakePanel, opened: 0 };
  const warn = vi.fn();
  const log = vi.fn();
  const launcher = createChatSessionLauncher({
    isServerReady: () => state.serverReady,
    openOrReveal: () => {
      state.opened += 1;
      // Mirrors ChatPanel.openOrReveal: a disposed primary is replaced by a new one.
      if (state.panel.disposed) state.panel = fakePanel(false);
      return state.panel;
    },
    warn,
    log,
  });
  return { state, warn, log, launcher };
}

describe("chat session launcher (#1764)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pins the routed timings: a 15 s queued deadline and a 1000 ms repeat window", () => {
    expect(LAUNCH_DEADLINE_MS).toBe(15_000);
    expect(REPEAT_LAUNCH_WINDOW_MS).toBe(1_000);
  });

  it("engine not ready: warns with New Project's exact copy and opens nothing", () => {
    const { state, warn, launcher } = harness({ serverReady: false });
    launcher.launch("/add-fleet-device");
    expect(warn).toHaveBeenCalledWith(SERVER_NOT_READY_WARNING);
    expect(SERVER_NOT_READY_WARNING).toBe(
      "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.",
    );
    expect(state.opened).toBe(0);
    expect(state.panel.posted).toEqual([]);
  });

  it("the not-ready warning is the very copy New Project shows (parity with createNewProject)", async () => {
    const vscode = await import("vscode");
    const w = vscode.window as unknown as { showWarningMessage: (...a: unknown[]) => unknown };
    const orig = w.showWarningMessage;
    const shown: unknown[] = [];
    w.showWarningMessage = (m: unknown) => {
      shown.push(m);
      return Promise.resolve(undefined);
    };
    try {
      const { createNewProject } = await import("../src/sidebar_view");
      await createNewProject({ isServerReady: () => false, launchSession: vi.fn() });
    } finally {
      w.showWarningMessage = orig;
    }
    expect(shown).toEqual([SERVER_NOT_READY_WARNING]);
  });

  it("panel ready: posts the navigate envelope immediately, once, and adds no app-ready subscriber", () => {
    const { state, warn, launcher } = harness();
    launcher.launch("/troubleshoot-fleet");
    expect(state.opened).toBe(1);
    expect(state.panel.posted).toEqual([nav("/troubleshoot-fleet")]);
    expect(state.panel.readySubscribers()).toBe(0);
    state.panel.fireAppReady(); // a later remount never re-sends
    expect(state.panel.posted).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("panel absent or still loading: queues for app-ready, then delivers exactly once", () => {
    const { state, launcher } = harness();
    state.panel = fakePanel(false); // loading
    launcher.launch("/add-fleet-device");
    expect(state.panel.posted).toEqual([]);
    state.panel.fireAppReady();
    expect(state.panel.posted).toEqual([nav("/add-fleet-device")]);
  });

  it("two app-ready events yield one delivery", () => {
    const { state, launcher } = harness();
    state.panel = fakePanel(false);
    launcher.launch("/add-fleet-device");
    state.panel.fireAppReady();
    state.panel.fireAppReady();
    expect(state.panel.posted).toHaveLength(1);
  });

  it("two different launches queued while loading are each delivered once", () => {
    const { state, launcher } = harness();
    state.panel = fakePanel(false);
    launcher.launch("/add-fleet-device");
    launcher.launch("/troubleshoot-fleet");
    expect(state.panel.posted).toEqual([]);
    state.panel.fireAppReady();
    state.panel.fireAppReady();
    expect(state.panel.posted).toEqual([nav("/add-fleet-device"), nav("/troubleshoot-fleet")]);
  });

  it("a repeat launch of the same prompt inside 1000 ms opens nothing more", () => {
    const { state, launcher } = harness();
    launcher.launch("/add-fleet-device");
    vi.advanceTimersByTime(999);
    launcher.launch("/add-fleet-device");
    expect(state.opened).toBe(1);
    expect(state.panel.posted).toHaveLength(1);
    // Outside the window it launches again.
    vi.advanceTimersByTime(2);
    launcher.launch("/add-fleet-device");
    expect(state.opened).toBe(2);
    expect(state.panel.posted).toHaveLength(2);
  });

  it("app-ready never arriving: drops the launch at 15 s with the did-not-load warning, never posts", () => {
    const { state, warn, launcher } = harness();
    state.panel = fakePanel(false);
    launcher.launch("/add-fleet-device");
    vi.advanceTimersByTime(LAUNCH_DEADLINE_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledWith(CHAT_DID_NOT_LOAD_WARNING);
    expect(CHAT_DID_NOT_LOAD_WARNING).toMatch(/did not finish loading/);
    // A late app-ready after the deadline delivers nothing.
    state.panel.fireAppReady();
    expect(state.panel.posted).toEqual([]);
  });

  it("a queued launch whose panel is disposed before app-ready is dropped with the same warning, never delivered into a later panel", () => {
    const { state, warn, launcher } = harness();
    const first = fakePanel(false);
    state.panel = first;
    launcher.launch("/add-fleet-device");
    first.dispose();
    expect(warn).toHaveBeenCalledWith(CHAT_DID_NOT_LOAD_WARNING);
    first.fireAppReady();
    expect(first.posted).toEqual([]);
    vi.advanceTimersByTime(LAUNCH_DEADLINE_MS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stale ready after dispose-and-reopen: the launch is queued on the new panel, then delivered once", () => {
    const { state, launcher } = harness();
    const old = state.panel; // ready
    old.dispose();
    launcher.launch("/troubleshoot-fleet");
    const fresh = state.panel;
    expect(fresh).not.toBe(old);
    expect(fresh.posted).toEqual([]);
    fresh.fireAppReady();
    fresh.fireAppReady();
    expect(fresh.posted).toEqual([nav("/troubleshoot-fleet")]);
    expect(old.posted).toEqual([]);
  });

  it("stale ready after the host resets the frame: the launch is queued, then delivered once", () => {
    const { state, launcher } = harness();
    state.panel.resetFrame();
    launcher.launch("/create-a-fleet");
    expect(state.panel.posted).toEqual([]);
    state.panel.fireAppReady();
    state.panel.fireAppReady();
    expect(state.panel.posted).toEqual([nav("/create-a-fleet")]);
  });
});
