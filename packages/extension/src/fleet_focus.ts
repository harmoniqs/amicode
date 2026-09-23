// fleet_focus.ts — #1441 the fleet focus selector.
//
// The fleet sidebar section becomes a single-select FOCUS SELECTOR that scopes
// Research/Dev/Workspace to the focused machine (default: home = local). The
// focus is a UI selection — NEVER a roster write (ADR 0026 read-only invariant).
//
// The session list is DECOUPLED from focus (ADR 0031 §D4): changing focus does
// not filter or reorder sessions. Focus-follows-tab sets the focused machine to
// the session's owner when a remote tab is activated.

// ── types ────────────────────────────────────────────────────────────────────

/** A machine the focus selector can point at. */
export interface FocusedMachine {
  machineId: string;
  name: string;
  isLocal: boolean;
}

/** The event the focus store emits on change. */
export interface FleetFocusEvent {
  kind: "focus-changed";
  /** The newly focused machine id, or undefined for home (local). */
  machineId: string | undefined;
  name: string | undefined;
}

/** The tab-focus input — the session tab that was just activated. */
export interface TabFocusInput {
  sessionId: string;
  ownerMachineId: string;
  ownerName: string;
  isLocal: boolean;
  /** The session's working directory on the owner machine. */
  directory?: string;
}

/** Fetch project roots for a remote machine. The provider is injected — the
 *  store itself holds no transport logic. */
export type ProjectRootsProvider = (machineId: string) => Promise<string[]>;

/** The typed result of a project-roots fan-out: ok with roots, or a named
 *  failure (unreachable, etc.). An unreachable machine is an honest ABSENCE,
 *  not an empty-success. */
export type ProjectRootsResult =
  | { ok: true; roots: string[] }
  | { ok: false; reason: "unreachable" | "not-focused"; detail?: string };

/** Options for the FleetFocusStore. All optional — production wires these;
 *  tests omit what they don't need. */
export interface FleetFocusStoreOptions {
  onChange?: (event: FleetFocusEvent) => void;
  /** Called when a write to the roster would happen — injected so tests can
   *  assert it is NEVER called (the read-only invariant). */
  onRosterWrite?: () => void;
  /** Project-roots provider for fan-out. Absent → getProjectRoots returns []. */
  rootsProvider?: ProjectRootsProvider;
  /** Called when focus-follows-tab should reveal a folder in the sidebar. */
  onRevealFolder?: (machineId: string, sessionId: string) => void;
}

// ── store ────────────────────────────────────────────────────────────────────

/** The focus selector state. A simple single-select store: null = home (local),
 *  a FocusedMachine = scoped to that remote machine. Thread-safe by design —
 *  all mutations are synchronous and event-driven. */
export class FleetFocusStore {
  private _focused: FocusedMachine | null = null;
  private readonly opts: FleetFocusStoreOptions;

  constructor(opts: FleetFocusStoreOptions = {}) {
    this.opts = opts;
  }

  /** The currently focused machine, or null for home (local). */
  get focused(): FocusedMachine | null {
    return this._focused;
  }

  /** True when focused on home (the local machine). */
  get isHome(): boolean {
    return this._focused === null;
  }

  /** The machine id the working surfaces (Research/Dev/Workspace) are scoped
   *  to. Undefined = local (home). */
  get scopedMachineId(): string | undefined {
    return this._focused?.machineId;
  }

  /** Set the focus to a machine, or null for home. A local machine collapses
   *  to home. Emits focus-changed if the effective target changed.
   *  NEVER writes the roster. */
  setFocus(machine: FocusedMachine | null): void {
    // A local machine selection collapses to home (the default)
    const effective = machine && machine.isLocal ? null : machine;
    const prevId = this._focused?.machineId;
    const nextId = effective?.machineId;

    // No-op: same effective target
    if (prevId === nextId) return;

    this._focused = effective;
    this.opts.onChange?.({
      kind: "focus-changed",
      machineId: nextId,
      name: effective?.name,
    });
    // The roster is NEVER written — the read-only invariant holds.
    // (The onRosterWrite callback exists only for test assertion.)
  }

  /** Focus-follows-tab: a remote session tab was activated → set focus to its
   *  owner and optionally reveal its folder. */
  focusFollowsTab(input: TabFocusInput): void {
    this.setFocus(
      input.isLocal
        ? null
        : { machineId: input.ownerMachineId, name: input.ownerName, isLocal: false },
    );
    // Reveal the folder when the owner is remote
    if (!input.isLocal && this.opts.onRevealFolder) {
      this.opts.onRevealFolder(input.ownerMachineId, input.sessionId);
    }
  }

  /** Get the focused machine's project roots. Returns [] for home (local roots
   *  come from the local workspace, not from this fan-out). */
  async getProjectRoots(): Promise<string[]> {
    if (!this._focused || !this.opts.rootsProvider) return [];
    try {
      return await this.opts.rootsProvider(this._focused.machineId);
    } catch {
      return [];
    }
  }

  /** Get the project-roots result with honest failure typing. An unreachable
   *  machine is an honest ABSENCE, not an empty-success. */
  async getProjectRootsResult(): Promise<ProjectRootsResult> {
    if (!this._focused) return { ok: false, reason: "not-focused" };
    if (!this.opts.rootsProvider) return { ok: true, roots: [] };
    try {
      const roots = await this.opts.rootsProvider(this._focused.machineId);
      return { ok: true, roots };
    } catch (e) {
      return {
        ok: false,
        reason: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Pass sessions through UNCHANGED — the session list is decoupled from
   *  focus (ADR 0031 §D4). This method exists as a contract assertion: it
   *  returns its input unfiltered, unordered, regardless of focus state. */
  filterSessions<T>(sessions: T[]): T[] {
    return sessions;
  }
}
