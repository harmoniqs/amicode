// prompt_up.ts — the always-local companion's PROMPT-UP orchestrator (#1277,
// ADR 0025 P3; part of #1269). It is the SIBLING of #1276's auto-DOWN
// (auto_switch.ts): both consume the SAME #1275 link-sensor posture stream, but
// they are ASYMMETRIC BY DESIGN — the whole point of this slice.
//
// ── THE ASYMMETRY (the Key Decision) ──────────────────────────────────────────
// A bad link is URGENT: auto-DOWN drops the frozen window to the local lifeboat
// WITHOUT asking (a wedged editor can't ask). A good link is NOT urgent: when the
// link RECOVERS, we do not yank the user back — we PROMPT, and reopen in
// Remote-SSH ONLY if they accept. Never a forced up-switch (AC2, invariant
// "No forced up-switch").
//
// ── WHAT "SUSTAINED RECOVERY" MEANS (honest, not re-derived) ───────────────────
// Recovery = the merged detector's `state` returns to `fleet`. The detector
// already applies recovery hysteresis (RECOVERY_CONSECUTIVE_HEALTHY = 3
// consecutive healthy outcomes before it re-enters `fleet`), so a `fleet` posture
// from the sensor IS "sustained per hysteresis" — a brief good patch never
// reaches `fleet`, so it never prompts (AC3). We do not re-derive sustain here.
//
// ── PAIRING WITH AUTO-DOWN (why we arm on the hub-down class) ──────────────────
// "Return to Remote-SSH" only makes sense if you LEFT it — and you leave it only
// when auto-DOWN drops you on a hub-down. So prompt-UP arms its recovery latch on
// EXACTLY the class auto-DOWN drops on (`isHubDownTrigger`: standalone + a
// "hub-down" pointer), and prompts when that episode recovers to `fleet`. A mere
// `degraded→fleet` (a slow link that was never dropped) is not a recovery to
// return from — it does not prompt.
//
// SCOPE (this slice): recovery detection + the prompt + a user-accepted reopen.
// NOT here: the auto-DOWN drop (#1276, its sibling) and cross-scheme editor-URI
// carry across the flip (#1278 — it will supply/refine the reopen TARGET this
// module builds, so open editors survive the return; today the target is the
// configured hub SSH alias + the home-default remote path).

import {
  resolveRemoteSshReopenTarget,
  reopenWindow,
  type ReopenDeps,
  type ReopenOutcome,
} from "./reopen";
import { isHubDownTrigger } from "./auto_switch";
import type { LinkPosture } from "./link_sensor";

/** The prompt-frequency floor: the minimum wall-clock interval between recovery
 *  prompts. With the detector's own recovery hysteresis it is the anti-spam
 *  guard — a link that flaps down↔up within this window prompts at most once.
 *  One minute — the same floor auto-DOWN uses, for a symmetric feel. */
export const DEFAULT_MIN_PROMPT_INTERVAL_MS = 60_000;

/** The reopen prompt (AC1). An INVITATION, never a fait accompli: it asks, names
 *  Remote-SSH, and promises the local session stays put on dismiss (never a
 *  forced switch). */
export const PROMPT_UP_MESSAGE =
  "Amicode Companion: the hub link has recovered and held steady — reopen this window in " +
  "Remote-SSH to return to the hub? Dismiss to stay in the local lifeboat; nothing switches unless you accept.";

/** The accept button label. In production the prompt is
 *  `showInformationMessage(PROMPT_UP_MESSAGE, PROMPT_UP_ACTION)` and accept ===
 *  this exact string coming back. */
export const PROMPT_UP_ACTION = "Reopen in Remote-SSH";

/** The honest notice when the link recovered but there is no Remote-SSH target to
 *  reopen into (no hub SSH alias). We show NO half-prompt (an offer we can't
 *  honor would mislead), but we are not silent either — this says why and what to
 *  fix. */
export const CANNOT_RESOLVE_MESSAGE =
  "Amicode Companion: the hub link recovered, but there is no Remote-SSH target to reopen into " +
  "(no hub SSH alias configured). Set the hub SSH alias and the next recovery will offer the reopen.";

/** What one posture did — returned from `handle` so the behavior is assertable
 *  without reading side effects alone (mirrors AutoDownAction). */
export type PromptUpAction =
  | "reopened" // accepted → the Remote-SSH window opened
  | "reopen-failed" // accepted → the reopen could not open (surfaced honestly)
  | "dismissed" // the prompt was shown; the user declined → nothing switched
  | "cannot-resolve-target" // recovery, but no resolvable Remote-SSH target — surfaced, no half-prompt
  | "suppressed-by-floor" // within the prompt-frequency floor — anti-flap held it
  | "not-a-recovery"; // not a recovery back to fleet from a hub-down episode

export interface PromptUpDeps {
  /** The hub's Remote-SSH alias the reopen targets. Captured at construction
   *  (like auto-DOWN's localPath). Blank/unresolvable → no half-prompt: the
   *  honest cannot-resolve notice fires instead. #1278 may back this with the
   *  fleet projection's sshAlias. */
  sshAlias: string;
  /** The remote workspace path (default `~`, the home default the resolver uses —
   *  coherent with the fleet state root ~/.amico/). */
  remotePath?: string;
  /** The clock, in ms — the prompt-frequency floor is measured against it.
   *  Production: `Date.now`. */
  now: () => number;
  /** Show the reopen prompt; resolves TRUE iff the user accepted. Production:
   *  `(msg, action) => (await vscode.window.showInformationMessage(msg, action)) === action`. */
  promptUser: (message: string, action: string) => Promise<boolean>;
  /** Surface the honest cannot-resolve notice (never silent). Production:
   *  `vscode.window.showWarningMessage`. */
  showMessage: (message: string) => void;
  /** Open the folder (the reopen sink, #1274). Optional: omitted → reopen falls
   *  back to `reopenWindow`'s default `vscode.openFolder` wiring. Tests inject a
   *  capture. */
  openFolder?: ReopenDeps["openFolder"];
  /** Surface a reopen error (the reopen's own honest error path, #1274).
   *  Production: `vscode.window.showErrorMessage`. */
  showError?: ReopenDeps["showError"];
  /** The prompt-frequency floor in ms. Default DEFAULT_MIN_PROMPT_INTERVAL_MS. */
  minPromptIntervalMs?: number;
  /** Whether the reopen forces a NEW window. Default false — returning UP flips
   *  the CURRENT (lifeboat) window back to Remote-SSH, the inverse of the drop. */
  forceNewWindow?: boolean;
}

/**
 * The prompt-UP orchestrator. Feed it the sensor's posture stream (bind
 * `onPosture` to the sensor's `onPosture`, or call `handle` directly). It arms a
 * latch whenever it sees the hub-down class (the episode auto-DOWN drops on) and,
 * on the SUSTAINED recovery back to `fleet`, PROMPTS to reopen in Remote-SSH —
 * reopening ONLY if the user accepts. It is otherwise inert.
 */
export class PromptUpSwitch {
  /** The last time we acted on a recovery (a prompt OR an honest cannot-resolve
   *  surface) — the prompt-frequency floor is measured against it. */
  private lastPromptAt: number | null = null;
  /** Latched TRUE while we are inside a hub-down episode (auto-DOWN's drop
   *  class), so the return to `fleet` is recognized as a recovery to RETURN
   *  from. Consumed (reset) the moment a recovery is recognized, so the fleet
   *  LEVEL repeated every tick does not re-prompt and a fresh episode re-arms. */
  private sawHubDown = false;
  private readonly minPromptIntervalMs: number;

  constructor(private readonly deps: PromptUpDeps) {
    this.minPromptIntervalMs = deps.minPromptIntervalMs ?? DEFAULT_MIN_PROMPT_INTERVAL_MS;
  }

  /** The sensor seam — bind this to the LinkSensor's `onPosture`, alongside
   *  auto-DOWN's. Fire-and-forget (the sensor does not await); the prompt +
   *  reopen are driven on the microtask queue. */
  readonly onPosture = (posture: LinkPosture): void => {
    void this.handle(posture);
  };

  /** Handle one posture. Returns what it did (assertable). Never throws — a
   *  reopen failure becomes a surfaced `reopen-failed`, not an exception. */
  async handle(posture: LinkPosture): Promise<PromptUpAction> {
    // Arm the latch on the SAME hub-down class auto-DOWN drops on (standalone +
    // a "hub-down" pointer). This is the pairing: we only offer to RETURN up
    // after a drop-worthy DOWN.
    if (isHubDownTrigger(posture)) this.sawHubDown = true;

    // Recovery = the detector is back in `fleet` AND we were in a hub-down
    // episode. The detector's recovery hysteresis already guarantees a brief
    // good patch never reached `fleet`, so reaching `fleet` here IS "sustained".
    const isRecovery = posture.state === "fleet" && this.sawHubDown;
    if (!isRecovery) return "not-a-recovery";

    // Recognized the recovery — consume the latch. A fresh hub-down episode will
    // re-arm; the repeated fleet LEVEL will not re-trigger (AC3, no re-prompt).
    this.sawHubDown = false;

    // ── Prompt-frequency floor ───────────────────────────────────────────────
    // Within the floor of the last recovery-action, suppress. The floor is
    // consumed on the ATTEMPT (like auto-DOWN's), so a flapping recovery — even
    // one that can't resolve a target — never storms the surface.
    const now = this.deps.now();
    if (this.lastPromptAt !== null && now - this.lastPromptAt < this.minPromptIntervalMs) {
      return "suppressed-by-floor";
    }
    this.lastPromptAt = now;

    // ── Resolve the Remote-SSH target FIRST — never a half-prompt ─────────────
    // If there is no target to reopen into, showing "reopen in Remote-SSH?" would
    // be an offer we can't honor. Surface the honest cannot-resolve notice
    // instead (not silent — invariant), and prompt NOTHING.
    const resolution = resolveRemoteSshReopenTarget(this.deps.sshAlias, this.deps.remotePath);
    if (!resolution.ok) {
      this.deps.showMessage(CANNOT_RESOLVE_MESSAGE);
      return "cannot-resolve-target";
    }

    // ── Prompt, then (only on accept) reopen UP ──────────────────────────────
    // AC2: the reopen fires ONLY if the user accepts. On dismiss we do NOTHING —
    // the local session stays put; nothing is forced.
    const accepted = await this.deps.promptUser(PROMPT_UP_MESSAGE, PROMPT_UP_ACTION);
    if (!accepted) return "dismissed";

    const reopenDeps: ReopenDeps = {};
    if (this.deps.openFolder !== undefined) reopenDeps.openFolder = this.deps.openFolder;
    if (this.deps.showError !== undefined) reopenDeps.showError = this.deps.showError;
    if (this.deps.forceNewWindow !== undefined) reopenDeps.forceNewWindow = this.deps.forceNewWindow;

    const outcome: ReopenOutcome = await reopenWindow(resolution, reopenDeps);
    return outcome.ok ? "reopened" : "reopen-failed";
  }
}
