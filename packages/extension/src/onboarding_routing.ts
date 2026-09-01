// Onboarding routing — session auto-launch and routing logic (#434)
//
// Pure routing predicate + launcher with at-most-once guard.
// Given (modelConfigured, welcomeShown, onboardingCompleted, partialStage),
// determines the correct action for the session.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OnboardingFlags {
  /** True if the opencode config has at least one provider entry with credentials. */
  modelConfigured: boolean;
  /** True if the Stage 0 welcome animation has been played this install. */
  welcomeShown: boolean;
  /** True if the full onboarding flow (through Stage 8) has completed. */
  onboardingCompleted: boolean;
  /** If partially completed, the last finished stage number (1-based). undefined = none. */
  partialStage: number | undefined;
}

/** The action the activation flow should take. */
export type OnboardingAction =
  | "show-webview"        // No model configured → open Stage 0 webview
  | "open-chat"           // Model present, onboarding not done → open chat (overture runs inside)
  | "resume-chat-at-stage" // Model present, partial progress → open chat at resume point
  | "normal-session";     // Onboarding complete → normal session (no onboarding UI)

// ─── Routing predicate (pure, testable) ──────────────────────────────────────

/** Determine what the session should do at activation.
 *  This is a PURE function of its inputs — no side effects, no I/O. */
export function resolveOnboardingAction(flags: OnboardingFlags): OnboardingAction {
  // Terminal state: onboarding is done → normal session
  if (flags.onboardingCompleted) return "normal-session";

  // No model → must configure before chat can work
  if (!flags.modelConfigured) return "show-webview";

  // Model present, partial progress → resume
  if (flags.partialStage !== undefined) return "resume-chat-at-stage";

  // Model present, no progress → start the agentic onboarding in chat
  return "open-chat";
}

// ─── Model-presence check ────────────────────────────────────────────────────

/** Check if the opencode config has a model/provider configured.
 *  Reads the config file at the given path (default: ~/.config/opencode/opencode.json[c]).
 *  Returns true if there's at least one provider entry OR a model field is set. */
export function isModelConfigured(
  configPath?: string,
): boolean {
  const paths = configPath
    ? [configPath]
    : [
        path.join(os.homedir(), ".config", "opencode", "opencode.json"),
        path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
      ];

  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, "utf8");
      // Strip single-line comments for JSONC tolerance
      const stripped = content.replace(/^\s*\/\/.*$/gm, "");
      const config = JSON.parse(stripped) as Record<string, unknown>;

      // A non-empty provider block is the primary signal
      const provider = config.provider;
      if (provider && typeof provider === "object" && Object.keys(provider as object).length > 0) return true;

      // A model field (e.g. "anthropic/claude-sonnet-4") is a secondary signal —
      // the user has configured a model even if the provider block is empty
      // (opencode resolves the provider at runtime via env vars or defaults)
      if (typeof config.model === "string" && config.model.trim() !== "") return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Also check secondary locations where env-based providers resolve:
 *  - process.env has ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
 *  These are resolved by opencode itself at runtime. */
export function hasProviderEnvVar(): boolean {
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "OPENROUTER_API_KEY",
  ];
  return keys.some((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

// ─── welcome_shown persistence ───────────────────────────────────────────────

const WELCOME_STATE_FILE = "onboarding_state.json";

/** Read whether the welcome animation has been shown (persisted across sessions). */
export function readWelcomeShown(
  statePath: string = path.join(os.homedir(), ".amico", "amicode", WELCOME_STATE_FILE),
): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    return data.welcome_shown === true;
  } catch {
    return false;
  }
}

/** Mark the welcome animation as shown. */
export function writeWelcomeShown(
  statePath: string = path.join(os.homedir(), ".amico", "amicode", WELCOME_STATE_FILE),
): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch { /* fresh file */ }
    fs.writeFileSync(statePath, JSON.stringify({ ...existing, welcome_shown: true }, null, 2) + "\n");
  } catch {
    // Non-critical — don't crash the extension
  }
}

// ─── Launcher (at-most-once guard) ──────────────────────────────────────────

export interface LauncherCallbacks {
  resolveFlags: () => OnboardingFlags;
  showWebview: () => void;
  openChat: () => void;
  openChatAtStage: (stage: number) => void;
}

/** Encapsulates the at-most-once launch logic for a VS Code window.
 *  Calling tryLaunch() multiple times fires the action only once.
 *  After webview success, onWebviewSuccess() opens chat. */
export class OnboardingLauncher {
  private launched = false;
  private callbacks: LauncherCallbacks;

  constructor(callbacks: LauncherCallbacks) {
    this.callbacks = callbacks;
  }

  /** Attempt to launch the onboarding flow. Fires at most once per instance. */
  tryLaunch(): void {
    if (this.launched) return;

    const flags = this.callbacks.resolveFlags();
    const action = resolveOnboardingAction(flags);

    if (action === "normal-session") return; // nothing to do

    this.launched = true;

    switch (action) {
      case "show-webview":
        this.callbacks.showWebview();
        break;
      case "open-chat":
        this.callbacks.openChat();
        break;
      case "resume-chat-at-stage":
        this.callbacks.openChatAtStage(flags.partialStage ?? 1);
        break;
    }
  }

  /** Called when the Stage 0 webview completes successfully.
   *  Transitions to the chat panel. */
  onWebviewSuccess(): void {
    this.callbacks.openChat();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// (defaultConfigPath removed — isModelConfigured checks both .json and .jsonc)
