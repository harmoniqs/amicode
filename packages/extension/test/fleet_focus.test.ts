// fleet_focus.test.ts — #1441 the fleet focus selector (ACs 1–4).
//
// The fleet sidebar section becomes a single-select FOCUS SELECTOR that scopes
// Research/Dev/Workspace to the focused machine (default: home). The focus is a
// UI selection — NEVER a roster write (the read-only-roster invariant, ADR 0026).
//
// AC1: focus selector — single-select, default home, scopes surfaces, no roster write
// AC2: project-roots fan-out — remote machine's roots; unreachable = absence
// AC3: focus-decoupling — session list unaffected by focus change
// AC4: focus-follows-tab — remote session tab → set focused machine to owner, reveal folder
import { describe, it, expect } from "vitest";
import {
  FleetFocusStore,
  type FocusedMachine,
  type ProjectRootsProvider,
  type FleetFocusEvent,
} from "../src/fleet_focus";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A device list (the roster the focus selector draws from). */
function devices(): FocusedMachine[] {
  return [
    { machineId: "local-mbp", name: "MacBook Pro", isLocal: true },
    { machineId: "mac-studio-01", name: "Mac Studio", isLocal: false },
    { machineId: "linux-box", name: "Linux Box", isLocal: false },
  ];
}

// ── AC1: focus selector ──────────────────────────────────────────────────────

describe("#1441 AC1 — focus selector: single-select, default home, scoping", () => {
  it("defaults to home (local machine) — focused is null", () => {
    const store = new FleetFocusStore();
    expect(store.focused).toBeNull();
    expect(store.isHome).toBe(true);
  });

  it("selecting a remote machine sets it as focused", () => {
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    expect(store.focused?.machineId).toBe("mac-studio-01");
    expect(store.isHome).toBe(false);
  });

  it("selecting home (null) returns to the default", () => {
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus(null);
    expect(store.focused).toBeNull();
    expect(store.isHome).toBe(true);
  });

  it("single-select: changing focus replaces the previous", () => {
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus({ machineId: "linux-box", name: "Linux Box", isLocal: false });
    expect(store.focused?.machineId).toBe("linux-box");
  });

  it("selecting the local machine explicitly is equivalent to home", () => {
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "local-mbp", name: "MacBook Pro", isLocal: true });
    // Setting focus to a local machine collapses to home
    expect(store.isHome).toBe(true);
    expect(store.focused).toBeNull();
  });

  it("scopes Research/Dev/Workspace to the focused machine", () => {
    const store = new FleetFocusStore();
    // When home: scoped to local
    expect(store.scopedMachineId).toBeUndefined();

    // When focused: scoped to that machine
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    expect(store.scopedMachineId).toBe("mac-studio-01");
  });

  it("NO roster write on focus change — assert write callback is never called", () => {
    let rosterWriteCalled = false;
    const store = new FleetFocusStore({
      onRosterWrite: () => { rosterWriteCalled = true; },
    });
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus(null);
    store.setFocus({ machineId: "linux-box", name: "Linux Box", isLocal: false });
    expect(rosterWriteCalled).toBe(false);
  });

  it("emits focus-changed events on change", () => {
    const events: FleetFocusEvent[] = [];
    const store = new FleetFocusStore({ onChange: (e) => events.push(e) });
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus(null);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("focus-changed");
    expect(events[0].machineId).toBe("mac-studio-01");
    expect(events[1].kind).toBe("focus-changed");
    expect(events[1].machineId).toBeUndefined();
  });

  it("does NOT emit on no-op (same machine selected twice)", () => {
    const events: FleetFocusEvent[] = [];
    const store = new FleetFocusStore({ onChange: (e) => events.push(e) });
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    expect(events).toHaveLength(1); // only the first change
  });
});

// ── AC2: project-roots fan-out ───────────────────────────────────────────────

describe("#1441 AC2 — project-roots fan-out for the focused machine", () => {
  it("returns the focused machine's project roots", async () => {
    const rootsProvider: ProjectRootsProvider = async (machineId) => {
      if (machineId === "mac-studio-01") return ["/Users/jj/harmoniqs/amicode", "/Users/jj/research"];
      return [];
    };
    const store = new FleetFocusStore({ rootsProvider });
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });

    const roots = await store.getProjectRoots();
    expect(roots).toEqual(["/Users/jj/harmoniqs/amicode", "/Users/jj/research"]);
  });

  it("returns empty for home (local — roots come from the local workspace)", async () => {
    const rootsProvider: ProjectRootsProvider = async () => ["/some/path"];
    const store = new FleetFocusStore({ rootsProvider });
    // Home: no remote roots to fan out
    const roots = await store.getProjectRoots();
    expect(roots).toEqual([]);
  });

  it("unreachable machine → honest ABSENCE, not empty-success", async () => {
    const rootsProvider: ProjectRootsProvider = async () => {
      throw new Error("unreachable");
    };
    const store = new FleetFocusStore({ rootsProvider });
    store.setFocus({ machineId: "down-box", name: "Down Box", isLocal: false });

    const result = await store.getProjectRootsResult();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unreachable");
  });

  it("different machines return different roots", async () => {
    const rootsProvider: ProjectRootsProvider = async (machineId) => {
      if (machineId === "machine-a") return ["/a/project"];
      if (machineId === "machine-b") return ["/b/project1", "/b/project2"];
      return [];
    };
    const store = new FleetFocusStore({ rootsProvider });

    store.setFocus({ machineId: "machine-a", name: "A", isLocal: false });
    expect(await store.getProjectRoots()).toEqual(["/a/project"]);

    store.setFocus({ machineId: "machine-b", name: "B", isLocal: false });
    expect(await store.getProjectRoots()).toEqual(["/b/project1", "/b/project2"]);
  });
});

// ── AC3: focus-decoupling ────────────────────────────────────────────────────

describe("#1441 AC3 — focus-decoupling: session list unaffected by focus change", () => {
  it("changing focus does NOT filter or reorder the session list", () => {
    const sessionList = [
      { id: "s1", owner: "local-mbp" },
      { id: "s2", owner: "mac-studio-01" },
      { id: "s3", owner: "linux-box" },
    ];
    const store = new FleetFocusStore();

    // Capture the session list BEFORE focus change
    const before = [...sessionList];

    // Change focus to a remote machine
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });

    // The session list is decoupled — unchanged
    expect(store.filterSessions(sessionList)).toEqual(before);
  });

  it("focus change to home does NOT filter sessions either", () => {
    const sessionList = [
      { id: "s1", owner: "local-mbp" },
      { id: "s2", owner: "mac-studio-01" },
    ];
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });
    store.setFocus(null); // back to home

    expect(store.filterSessions(sessionList)).toEqual(sessionList);
  });
});

// ── AC4: focus-follows-tab ───────────────────────────────────────────────────

describe("#1441 AC4 — focus-follows-tab: remote session tab → set focus to owner", () => {
  it("focusing a remote session tab sets the focused machine to its owner", () => {
    const store = new FleetFocusStore();
    store.focusFollowsTab({
      sessionId: "s2",
      ownerMachineId: "mac-studio-01",
      ownerName: "Mac Studio",
      isLocal: false,
    });
    expect(store.focused?.machineId).toBe("mac-studio-01");
  });

  it("focusing a local session tab returns focus to home", () => {
    const store = new FleetFocusStore();
    store.setFocus({ machineId: "mac-studio-01", name: "Mac Studio", isLocal: false });

    store.focusFollowsTab({
      sessionId: "s1",
      ownerMachineId: "local-mbp",
      ownerName: "MacBook Pro",
      isLocal: true,
    });
    expect(store.isHome).toBe(true);
  });

  it("focus-follows-tab reveals the session's folder", () => {
    const revealed: string[] = [];
    const store = new FleetFocusStore({
      onRevealFolder: (machineId, sessionId) => {
        revealed.push(`${machineId}:${sessionId}`);
      },
    });
    store.focusFollowsTab({
      sessionId: "s2",
      ownerMachineId: "mac-studio-01",
      ownerName: "Mac Studio",
      isLocal: false,
      directory: "/Users/jj/harmoniqs/amicode",
    });
    expect(revealed).toEqual(["mac-studio-01:s2"]);
  });

  it("focus-follows-tab does NOT write the roster", () => {
    let rosterWriteCalled = false;
    const store = new FleetFocusStore({
      onRosterWrite: () => { rosterWriteCalled = true; },
    });
    store.focusFollowsTab({
      sessionId: "s2",
      ownerMachineId: "mac-studio-01",
      ownerName: "Mac Studio",
      isLocal: false,
    });
    expect(rosterWriteCalled).toBe(false);
  });
});
