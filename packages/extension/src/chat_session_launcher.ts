// chat_session_launcher.ts — #1764 the shared chat-session launcher.
//
// One seam for "open the chat and start a session running <prompt>": it
// opens-or-reveals the primary chat panel and posts the SAME navigate envelope
// New Project posts (`/new-session?prompt=…&autoSend=1`), which the chat app
// already honours — so there is no overlay change.
//
// Delivery contract:
//   - engine not ready → New Project's exact "server isn't ready yet" warning;
//   - the panel's app signalled ready since its last dispose / frame set →
//     post immediately (no app-ready subscriber is added);
//   - otherwise → queue for that panel's next app-ready under a 15 s deadline;
//     a deadline miss, or the panel disposing first, drops the launch with a
//     "did not finish loading" warning — never a silent no-op, never a
//     delivery into a later panel;
//   - each launch queues independently; a per-launch sent-guard backstops any
//     second delivery (and logs when it trips);
//   - a repeat of the same prompt within 1000 ms opens nothing more.
//
// Pure and dependency-injected: no vscode import, so the suite drives it with a
// fake panel and fake timers.

/** New Project's not-ready copy, verbatim (createNewProject in sidebar_view). */
export const SERVER_NOT_READY_WARNING =
  "Amicode: opencode server isn't ready yet. Check the 'Amicode — opencode' output channel.";

/** Shown when a queued launch never saw app-ready (deadline or panel disposed). */
export const CHAT_DID_NOT_LOAD_WARNING =
  "Amicode: the chat did not finish loading, so the session was not started. Try again.";

/** How long a queued launch waits for app-ready before it is dropped. */
export const LAUNCH_DEADLINE_MS = 15_000;

/** A repeat launch of the same prompt inside this window is suppressed. */
export const REPEAT_LAUNCH_WINDOW_MS = 1_000;

/** The slice of a chat panel the launcher needs (ChatPanel implements it). */
export interface LaunchTarget {
  /** True only when the app signalled ready since the last dispose / frame set. */
  isAppReady(): boolean;
  postMessage(msg: unknown): unknown;
  /** Subscribe to this panel's app-ready; returns the unsubscribe. */
  subscribeAppReady(cb: () => void): () => void;
  /** Subscribe to this panel's dispose; returns the unsubscribe. */
  subscribeDispose(cb: () => void): () => void;
}

export interface ChatSessionLauncherDeps {
  isServerReady(): boolean;
  /** Open or reveal the primary chat panel. Only called when the server is ready. */
  openOrReveal(): LaunchTarget;
  /** Surface a user-visible warning (production: showWarningMessage). */
  warn(message: string): void;
  /** Append a diagnostic line (production: the extension output channel). */
  log?(line: string): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface ChatSessionLauncher {
  launch(prompt: string): void;
}

/** The navigate envelope New Project, Troubleshoot, and Add machine post. */
export function newSessionNavigate(prompt: string): { source: "amicode"; kind: "navigate"; path: string } {
  return {
    source: "amicode",
    kind: "navigate",
    path: `/new-session?prompt=${encodeURIComponent(prompt)}&autoSend=1`,
  };
}

export function createChatSessionLauncher(deps: ChatSessionLauncherDeps): ChatSessionLauncher {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lastLaunchAt = new Map<string, number>();

  function launch(prompt: string): void {
    if (!deps.isServerReady()) {
      deps.warn(SERVER_NOT_READY_WARNING);
      return;
    }
    const t = now();
    const prev = lastLaunchAt.get(prompt);
    if (prev !== undefined && t - prev < REPEAT_LAUNCH_WINDOW_MS) {
      deps.log?.(`[chat-launcher] repeat launch of ${prompt} within ${REPEAT_LAUNCH_WINDOW_MS} ms suppressed`);
      return;
    }
    lastLaunchAt.set(prompt, t);

    const target = deps.openOrReveal();
    const envelope = newSessionNavigate(prompt);
    if (target.isAppReady()) {
      void target.postMessage(envelope);
      return;
    }

    // Queued: deliver on this panel's next app-ready, once.
    let settled = false;
    let sent = false;
    const cleanups: Array<() => void> = [];
    const settle = () => {
      settled = true;
      for (const c of cleanups.splice(0)) c();
    };
    const drop = (why: string) => {
      if (settled) return;
      settle();
      deps.log?.(`[chat-launcher] dropped ${prompt}: ${why}`);
      deps.warn(CHAT_DID_NOT_LOAD_WARNING);
    };
    cleanups.push(
      target.subscribeAppReady(() => {
        if (sent) {
          deps.log?.(`[chat-launcher] sent-guard tripped: ${prompt} already delivered`);
          return;
        }
        if (settled) return;
        sent = true;
        settle();
        void target.postMessage(envelope);
      }),
    );
    cleanups.push(target.subscribeDispose(() => drop("panel disposed before app-ready")));
    const timer = setTimer(() => drop(`no app-ready within ${LAUNCH_DEADLINE_MS} ms`), LAUNCH_DEADLINE_MS);
    cleanups.push(() => clearTimer(timer));
  }

  return { launch };
}
