// fleet_focus_store.test.ts — #1484 AC2: focus persists and scopes
// roots/workspace to the selected peer; focusing a remote session follows its
// owner without changing local identity/knowledge.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FleetFocusStore,
  type FocusState,
} from "../src/amicode_service/fleet_focus_store";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "focus-store-test-"));
  storePath = join(tmpDir, "focus.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("#1484 AC2 — FleetFocusStore persists focus", () => {
  it("defaults to home (no focused machine)", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    const state = store.getFocus();
    expect(state.machineId).toBeUndefined();
    expect(state.isHome).toBe(true);
  });

  it("setFocus persists the focused machine to disk", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.setFocus("peer-a");
    expect(existsSync(storePath)).toBe(true);
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    expect(raw.focusedMachineId).toBe("peer-a");
  });

  it("a new store instance reads back the persisted focus (survives reload)", () => {
    const store1 = new FleetFocusStore({ filePath: storePath });
    store1.setFocus("peer-a");

    const store2 = new FleetFocusStore({ filePath: storePath });
    const state = store2.getFocus();
    expect(state.machineId).toBe("peer-a");
    expect(state.isHome).toBe(false);
  });

  it("clearFocus returns to home and persists", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.setFocus("peer-a");
    store.clearFocus();
    const state = store.getFocus();
    expect(state.isHome).toBe(true);
    expect(state.machineId).toBeUndefined();

    // survives reload
    const store2 = new FleetFocusStore({ filePath: storePath });
    expect(store2.getFocus().isHome).toBe(true);
  });
});

describe("#1484 AC2 — named absence when focused peer is unavailable", () => {
  it("reports absent:true with reason when the focused peer is not in the available set", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.setFocus("peer-a");
    const state = store.getFocus(new Set(["peer-b"])); // peer-a not available
    expect(state.machineId).toBe("peer-a");
    expect(state.absent).toBe(true);
    expect(state.reason).toBe("peer-unavailable");
  });

  it("reports absent:false when the focused peer IS in the available set", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.setFocus("peer-a");
    const state = store.getFocus(new Set(["peer-a", "peer-b"]));
    expect(state.machineId).toBe("peer-a");
    expect(state.absent).toBe(false);
  });

  it("absence does NOT clear the persisted focus (the peer can come back)", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.setFocus("peer-a");
    store.getFocus(new Set(["peer-b"])); // observe absence
    // still persisted
    const store2 = new FleetFocusStore({ filePath: storePath });
    expect(store2.getFocus().machineId).toBe("peer-a");
  });

  it("home focus is never absent (no machine to be unavailable)", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    const state = store.getFocus(new Set());
    expect(state.isHome).toBe(true);
    expect(state.absent).toBe(false);
  });
});

describe("#1484 AC2 — focusing a remote session follows its owner", () => {
  it("focusSessionOwner sets focus to the session's owner machine", () => {
    const store = new FleetFocusStore({ filePath: storePath });
    store.focusSessionOwner("peer-b");
    const state = store.getFocus();
    expect(state.machineId).toBe("peer-b");
    expect(state.isHome).toBe(false);
  });

  it("focusing a local session's owner clears focus to home", () => {
    const store = new FleetFocusStore({ filePath: storePath, localMachineId: "local-mac" });
    store.setFocus("peer-a"); // start focused on a remote peer
    store.focusSessionOwner("local-mac"); // follow a local session
    const state = store.getFocus();
    expect(state.isHome).toBe(true);
  });
});
