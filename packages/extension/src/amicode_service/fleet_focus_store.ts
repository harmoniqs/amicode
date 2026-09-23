// FLEET FOCUS STORE (#1484, AC2) — persists the focused machine ID so focus
// survives reload, tracks named absence when the focused peer is unavailable,
// and follows a remote session's owner without changing local identity.
//
// Focus is a USER-LEVEL concept: "which machine am I looking at?" It scopes
// roots/workspace to the selected peer. It does NOT change who you are (local
// identity) or what you know (local knowledge/vault state).
//
// Persistence: the store writes a tiny JSON file — the focused machine_id —
// so a reload or restart picks up where you left off. A missing file = home.
//
// Named absence: when the focused peer is not in the current available set,
// getFocus reports `absent: true` with a reason. The persisted focus is NOT
// cleared — the peer can come back. Only an explicit clearFocus() returns
// to home.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── types ────────────────────────────────────────────────────────────────────

export interface FocusState {
  /** The focused machine ID, or undefined for home (local). */
  machineId: string | undefined;
  /** True when focus is home (no remote peer focused). */
  isHome: boolean;
  /** True when the focused peer is not in the available set (named absence).
   *  Always false for home focus. */
  absent: boolean;
  /** The absence reason when absent is true. */
  reason?: string;
}

export interface FleetFocusStoreOpts {
  /** The file path to persist focus state. */
  filePath: string;
  /** This machine's own stable ID — used to collapse local owner focus to home. */
  localMachineId?: string;
}

// ── the store ────────────────────────────────────────────────────────────────

interface PersistedFocus {
  focusedMachineId?: string;
}

export class FleetFocusStore {
  private readonly filePath: string;
  private readonly localMachineId: string | undefined;

  constructor(opts: FleetFocusStoreOpts) {
    this.filePath = opts.filePath;
    this.localMachineId = opts.localMachineId;
  }

  /** Get the current focus state. When `availablePeers` is provided,
   *  reports named absence if the focused peer is not in the set. */
  getFocus(availablePeers?: ReadonlySet<string>): FocusState {
    const machineId = this.readPersisted();
    if (machineId === undefined) {
      return { machineId: undefined, isHome: true, absent: false };
    }
    const absent = availablePeers !== undefined && !availablePeers.has(machineId);
    return {
      machineId,
      isHome: false,
      absent,
      ...(absent ? { reason: "peer-unavailable" } : {}),
    };
  }

  /** Set focus to a specific remote machine. Persists immediately. */
  setFocus(machineId: string): void {
    this.writePersisted(machineId);
  }

  /** Clear focus to home. Persists immediately. */
  clearFocus(): void {
    this.writePersisted(undefined);
  }

  /** Follow a session's owner: if the owner is local, clear to home;
   *  if remote, focus on the owner's machine. */
  focusSessionOwner(ownerMachineId: string): void {
    if (this.localMachineId !== undefined && ownerMachineId === this.localMachineId) {
      this.clearFocus();
    } else {
      this.setFocus(ownerMachineId);
    }
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private readPersisted(): string | undefined {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as PersistedFocus;
      return typeof data.focusedMachineId === "string" ? data.focusedMachineId : undefined;
    } catch {
      return undefined; // file doesn't exist or is malformed → home
    }
  }

  private writePersisted(machineId: string | undefined): void {
    const data: PersistedFocus = {};
    if (machineId !== undefined) data.focusedMachineId = machineId;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }
}
