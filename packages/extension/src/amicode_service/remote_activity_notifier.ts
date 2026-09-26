// REMOTE ACTIVITY NOTIFIER (#1569, B2) — notifies the host when a remote
// machine starts driving a local session. Rate-limited: one notification per
// session per activity burst. Dependency-injected (no direct vscode import) so
// it is testable under vitest without the extension host.
//
// The notifier is a CLASS with injected deps (showInformationMessage,
// onViewSession, clock) so each test gets its own instance with fresh state.

// ── types ────────────────────────────────────────────────────────────────────

export interface RemoteActivityEvent {
  sessionId: string;
  sessionTitle?: string;
  controllerMachineId: string;
  controllerMachineName: string;
}

export interface RemoteActivityNotifierDeps {
  /** vscode.window.showInformationMessage — injected for testability. */
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  /** Called when the user clicks "View" — the wiring navigates to the session. */
  onViewSession: (sessionId: string) => void;
  /** Injectable clock for testable rate-limiting. Default: Date.now. */
  now?: () => number;
}

// ── notifier ─────────────────────────────────────────────────────────────────

const NOTIFICATION_COOLDOWN_MS = 60_000; // 1 minute cooldown per session

export class RemoteActivityNotifier {
  private readonly deps: RemoteActivityNotifierDeps;
  /** Track recently notified sessions to avoid spam: sessionId → timestamp. */
  private readonly recentNotifications = new Map<string, number>();

  constructor(deps: RemoteActivityNotifierDeps) {
    this.deps = deps;
  }

  /** Fire a host notification for remote activity on a local session. Rate-
   *  limited: a second call for the same session within the cooldown is
   *  suppressed. */
  notify(event: RemoteActivityEvent): void {
    const now = (this.deps.now ?? Date.now)();
    const lastNotified = this.recentNotifications.get(event.sessionId);
    if (lastNotified !== undefined && now - lastNotified < NOTIFICATION_COOLDOWN_MS) {
      return; // rate-limited
    }
    this.recentNotifications.set(event.sessionId, now);

    const title = event.sessionTitle || event.sessionId;
    const message = `${event.controllerMachineName} is driving session "${title}"`;

    void Promise.resolve(this.deps.showInformationMessage(message, "View")).then((action) => {
      if (action === "View") {
        this.deps.onViewSession(event.sessionId);
      }
    });
  }

  /** Clear the rate-limit cache (for tests or cleanup). */
  clearCache(): void {
    this.recentNotifications.clear();
  }
}
