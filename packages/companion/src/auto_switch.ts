// auto_switch.ts — the always-local companion's AUTO-DOWN orchestrator (#1276,
// ADR 0025 P3, invariant 5; part of #1269). It consumes the #1275 link sensor's
// posture stream and, on a SUSTAINED hub-down link, drops the window to the
// LOCAL thin-client lifeboat (#1274's reopen, into the #1267 host-file mount) —
// SAFELY (a switch-frequency floor + a dirty-editor guard + anti-flap, so a
// flapping link never storms the window with reloads) and VISIBLY (the drop is
// surfaced before it happens — never a silent reroute, ADR 0025 invariant 5).
//
// ── WHAT IS HONEST HERE ───────────────────────────────────────────────────────
// The trigger is the MERGED detector's OWN classification, verbatim: hub-down =
// the `standalone` state carrying the detector's "hub-down" pointer. The detector
// already applies hysteresis (N=3 consecutive no-responses before it emits
// `standalone`), so a standalone posture from the sensor IS "sustained per
// hysteresis" — the orchestrator does not re-derive sustain. `degraded`
// (hub-up-but-slow) is a badge, never a drop.
//
// The claim on the drop is honest: the host session is preserved and RESUMES on
// reconnect, and the LOCAL shell + host files (via the #1267 lifeboat mount) stay
// available. It does NOT claim "chat continues" during the outage — a hub-down
// link is unreachable from the lifeboat too; the chat is what went dark.
//
// SCOPE (this slice): the auto-DOWN reopen + the guards + the surface. NOT here:
// prompt-UP on recovery (#1277 — it will consume this same posture seam, watching
// for the recovery transition back to `fleet`). Cross-scheme editor-URI carry
// across the switch (#1278) IS now wired here: when `deps.editorCarry` is
// supplied, the open host editors are carried DOWN across the flip (see the carry
// step in `handle`); when it is not, the drop carries the folder target only.

import {
  resolveLocalReopenTarget,
  reopenWindow,
  type ReopenDeps,
  type ReopenOutcome,
} from "./reopen";
import { carryOpenEditors, type EditorCarryDeps } from "./editor_carry";
import type { LinkPosture } from "./link_sensor";

/** The switch-frequency floor: the minimum wall-clock interval between window
 *  reopens. Combined with the sensor's own hysteresis, it is the anti-flap
 *  guard — a link that flaps standalone↔fleet within this window reopens at most
 *  once. One minute: long enough that a genuinely flapping link never storms the
 *  window, short enough that a real second outage after a real recovery still
 *  drops. */
export const DEFAULT_MIN_SWITCH_INTERVAL_MS = 60_000;

/** The surfaced transition message (AC2). Honest by construction: it names the
 *  drop, promises only what the lifeboat can keep (session preserved + resumes on
 *  reconnect; local shell + host files stay), and never claims the chat keeps
 *  flowing during the outage. */
export const AUTO_DOWN_MESSAGE =
  "Amicode Companion: the hub link has been down long enough to freeze the editor — " +
  "dropping this window to the local thin-client lifeboat. Your host session is preserved " +
  "and resumes when the link recovers; the local shell and host files (via the lifeboat mount) " +
  "stay available.";

/** The surfaced DEFERRAL message when the drop is held by unsaved work (AC3's
 *  dirty guard). Also honest, also never silent — the user is told why the window
 *  did not drop and what to do. */
export const DIRTY_DEFERRAL_MESSAGE =
  "Amicode Companion: the hub link is down, but this window has unsaved changes — " +
  "holding the drop to the local lifeboat. Save your work and the window will reopen locally.";

/** The hub-down CLASS test (AC1): the merged detector's `standalone` state
 *  carrying its "hub-down" pointer. `degraded` (pointer null) and `fleet` are
 *  not the class — only a genuinely unreachable hub is. The pointer check makes
 *  the intent explicit and refuses a bare standalone with no hub-down reason. */
export function isHubDownTrigger(posture: LinkPosture): boolean {
  return posture.state === "standalone" && (posture.pointer ?? "").includes("hub-down");
}

/** What one posture did — returned from `handle` so the behavior is assertable
 *  without reading side effects alone. */
export type AutoDownAction =
  | "reopened" // the drop fired and the local window opened
  | "reopen-failed" // the drop fired but the reopen could not open (surfaced)
  | "suppressed-by-floor" // within the switch-frequency floor — anti-flap held it
  | "blocked-dirty" // unsaved editors — the dirty guard held it
  | "not-a-trigger"; // not the hub-down class (degraded/fleet/etc.)

export interface AutoDownDeps {
  /** The absolute LOCAL folder the lifeboat drops into (the thin-client posture).
   *  #1278 carries the open host editors across the switch on top of this target
   *  (see `editorCarry`), so the drop keeps the user's place, not just the folder. */
  localPath: string;
  /** The clock, in ms — the switch-frequency floor is measured against it.
   *  Production: `Date.now`. */
  now: () => number;
  /** Whether any editor has unsaved changes — the dirty guard. Production:
   *  `() => vscode.workspace.textDocuments.some((d) => d.isDirty)`. */
  isEditorDirty: () => boolean;
  /** Surface the transition to the user (AC2 — never silent). Production:
   *  `vscode.window.showWarningMessage`. */
  showMessage: (message: string) => void;
  /** Open the local folder (the reopen sink, #1274). Optional: when omitted, the
   *  reopen falls back to `reopenWindow`'s own default `vscode.openFolder` wiring
   *  — the single production default. Tests inject a capture. */
  openFolder?: ReopenDeps["openFolder"];
  /** Surface a reopen error (the reopen's own honest error path, #1274).
   *  Production: `vscode.window.showErrorMessage`. */
  showError?: ReopenDeps["showError"];
  /** The switch-frequency floor in ms. Default DEFAULT_MIN_SWITCH_INTERVAL_MS. */
  minSwitchIntervalMs?: number;
  /** Whether the drop forces a NEW window. Default false — the auto-DOWN flips
   *  the CURRENT (frozen) window to the lifeboat. */
  forceNewWindow?: boolean;
  /** #1278 cross-scheme editor-URI carry. When wired, the open host-file editors
   *  are carried DOWN across the flip (their `vscode-remote://ssh-remote+<alias>/`
   *  URIs → `amico-host:/` at the same logical path) so the user keeps their
   *  place; un-carryable editors are reported, never silently dropped. Optional —
   *  when omitted the drop carries the folder only, exactly as before this slice. */
  editorCarry?: EditorCarryDeps;
}

/**
 * The auto-DOWN orchestrator. Feed it the sensor's posture stream (pass
 * `onPosture` as the sensor's `onPosture`, or call `handle` directly). On the
 * hub-down class it drops the window to the local lifeboat — once, guarded, and
 * surfaced. It is otherwise inert: `degraded`/`fleet` postures do nothing.
 */
export class AutoDownSwitch {
  private lastSwitchAt: number | null = null;
  /** One dirty-deferral notice per down-episode — reset whenever the link is not
   *  in the hub-down class (a fresh episode may notify again), so a flapping
   *  dirty link is not spammed with deferral notices. */
  private dirtyNotified = false;
  private readonly minSwitchIntervalMs: number;

  constructor(private readonly deps: AutoDownDeps) {
    this.minSwitchIntervalMs = deps.minSwitchIntervalMs ?? DEFAULT_MIN_SWITCH_INTERVAL_MS;
  }

  /** The sensor seam — bind this to the LinkSensor's `onPosture`. Fire-and-forget
   *  (the sensor does not await); the reopen is driven on the microtask queue. */
  readonly onPosture = (posture: LinkPosture): void => {
    void this.handle(posture);
  };

  /** Handle one posture. Returns what it did (assertable). Never throws — a
   *  reopen failure becomes a surfaced `reopen-failed`, not an exception. */
  async handle(posture: LinkPosture): Promise<AutoDownAction> {
    if (!isHubDownTrigger(posture)) {
      // Not the hub-down class — arm the next episode's single dirty notice.
      this.dirtyNotified = false;
      return "not-a-trigger";
    }

    // ── Anti-flap / switch-frequency floor ──────────────────────────────────
    // Within the floor of the last drop, suppress. This is the storm guard: the
    // sensor emits the `standalone` LEVEL every tick while down, and a flapping
    // link re-enters standalone repeatedly — the floor collapses all of that to
    // at most one reopen per floor window.
    const now = this.deps.now();
    if (this.lastSwitchAt !== null && now - this.lastSwitchAt < this.minSwitchIntervalMs) {
      return "suppressed-by-floor";
    }

    // ── Dirty-editor guard ──────────────────────────────────────────────────
    // Never yank the window out from under unsaved work. Hold the drop and
    // surface why (once per episode); a later trigger, once saved, will drop.
    if (this.deps.isEditorDirty()) {
      if (!this.dirtyNotified) {
        this.deps.showMessage(DIRTY_DEFERRAL_MESSAGE);
        this.dirtyNotified = true;
      }
      return "blocked-dirty";
    }

    // ── Surface, then drop ──────────────────────────────────────────────────
    // ADR 0025 invariant 5: never a silent reroute. Resolve the local target
    // FIRST — we surface the "dropping to the lifeboat" transition ONLY when we
    // can actually honor it (never a misleading claim we can't keep). An
    // unresolvable target (a misconfigured local folder) is still surfaced — by
    // the reopen's OWN honest error path — so the invariant holds either way.
    const resolution = resolveLocalReopenTarget(this.deps.localPath);
    const reopenDeps: ReopenDeps = {};
    if (this.deps.openFolder !== undefined) reopenDeps.openFolder = this.deps.openFolder;
    if (this.deps.showError !== undefined) reopenDeps.showError = this.deps.showError;
    if (this.deps.forceNewWindow !== undefined) reopenDeps.forceNewWindow = this.deps.forceNewWindow;

    if (resolution.ok) {
      this.deps.showMessage(AUTO_DOWN_MESSAGE);
      // #1278: carry the open host editors DOWN across the flip (remote → local)
      // so the user keeps their place, not just the folder. Captured + enqueued
      // BEFORE the reopen (the window reload discards live editors); a host editor
      // that cannot be mapped is reported by the carry, never silently dropped.
      // Only on a committed drop (resolution.ok) — an unresolvable target never
      // switched, so the editors stay valid where they are.
      if (this.deps.editorCarry !== undefined) {
        await carryOpenEditors("amico-host", this.deps.editorCarry);
      }
    }
    // Record the switch time BEFORE the awaited reopen so a re-entrant tick
    // during the flip is already throttled — the floor holds even mid-drop, and
    // a persistently-broken target cannot storm the surface either.
    this.lastSwitchAt = now;
    this.dirtyNotified = false;

    const outcome: ReopenOutcome = await reopenWindow(resolution, reopenDeps);
    return outcome.ok ? "reopened" : "reopen-failed";
  }
}
