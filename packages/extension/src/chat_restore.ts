// ============================================================================
// Chat-tab restore (#705).
//
// VS Code re-opens webview editor tabs on window reload. Before this module the
// extension registered no WebviewPanelSerializer for "amicode.chat", so every
// restored tab came back as a dead panel — and a tab whose session's turn was
// killed by a server restart mid-flight hung forever waiting for stream events
// that will never arrive. The serializer (wired in extension.ts) now:
//   - restores a tab whose session is healthy (re-frames the app, navigates to
//     the session),
//   - renders an explicit "turn interrupted — resume?" state for a tab whose
//     session's last turn is dangling (the engine is no longer running it),
//   - closes a tab it cannot restore at all (no server reachable in time).
//
// This file is the pure part: state parsing, the dangling-turn verdict, the
// server probe, and the interrupted-state HTML. No `vscode` import, so it is
// unit-testable without the host.
// ============================================================================

/** What the chat webview persists via `vscode.setState` (survives reload). */
export interface RestoredChatState {
  sessionID?: string;
}

/** Tolerant parse of the opaque state VS Code hands the serializer. */
export function parseRestoredState(state: unknown): RestoredChatState {
  if (!state || typeof state !== "object") return {};
  const id = (state as { sessionID?: unknown }).sessionID;
  return typeof id === "string" && id !== "" ? { sessionID: id } : {};
}

export type TurnVerdict = "interrupted" | "ok";

interface MessageLike {
  info?: { role?: unknown; time?: { completed?: unknown }; error?: unknown };
}

/**
 * Is the session's last turn dangling? True when the engine is NOT running the
 * session (`busy` false) yet the transcript ends mid-turn: the last message is
 * a user message with no assistant reply, or an assistant message that never
 * completed (no `time.completed` and no recorded error).
 */
export function turnVerdict(messages: unknown, busy: boolean): TurnVerdict {
  if (busy) return "ok";
  if (!Array.isArray(messages) || messages.length === 0) return "ok";
  const last = messages[messages.length - 1] as MessageLike | undefined;
  const info = last?.info;
  if (!info || typeof info !== "object") return "ok";
  if (info.role === "user") return "interrupted";
  if (info.role === "assistant") {
    const completed = info.time?.completed;
    const hasCompleted = typeof completed === "number" || (typeof completed === "string" && completed !== "");
    return hasCompleted || info.error ? "ok" : "interrupted";
  }
  return "ok";
}

export interface ProbeServer {
  url: URL;
  /** Full Authorization header value (e.g. `Basic …`). */
  authorization?: string;
}

/**
 * Ask the server whether this session's last turn is dangling. Never throws:
 * any failure (network, auth, shape) yields "ok" so a transient probe problem
 * restores the tab normally rather than mislabelling a healthy session.
 */
export async function probeSessionTurn(
  server: ProbeServer,
  sessionID: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnVerdict> {
  const headers: Record<string, string> = server.authorization ? { Authorization: server.authorization } : {};
  try {
    const messagesRes = await fetchImpl(
      new URL(`/session/${encodeURIComponent(sessionID)}/message`, server.url).toString(),
      { method: "GET", headers },
    );
    if (!messagesRes.ok) return "ok";
    const messages = await messagesRes.json();
    let busy = false;
    try {
      const statusRes = await fetchImpl(new URL("/session/status", server.url).toString(), { method: "GET", headers });
      if (statusRes.ok) {
        const map = (await statusRes.json()) as Record<string, { type?: unknown }> | null;
        const entry = map && typeof map === "object" ? map[sessionID] : undefined;
        busy = !!entry && typeof entry === "object" && entry.type !== "idle";
      }
    } catch {
      /* status is advisory; the transcript verdict stands */
    }
    return turnVerdict(messages, busy);
  } catch {
    return "ok";
  }
}

/** The envelope the interrupted-state page posts when the user clicks Resume. */
export const RESTORE_RESUME_KIND = "restore-resume";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Static "turn interrupted — resume?" page for a restored tab. It re-persists
 * the session id (so another reload keeps the tab honest) and posts a single
 * `restore-resume` envelope on click; the host swaps the page for the live chat.
 */
export function renderInterruptedHtml(sessionID: string, nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ");
  const id = JSON.stringify(sessionID).replace(/</g, "\\u003c");
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; align-items: center; justify-content: center; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family, system-ui); }
    .card { max-width: 28rem; padding: 24px; text-align: center; }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: var(--vscode-descriptionForeground, inherit); line-height: 1.4; }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
    button { font: inherit; padding: 6px 14px; border: 0; border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="card" data-testid="turn-interrupted">
    <h1>Turn interrupted</h1>
    <p>This chat was mid-turn when the server restarted, so the reply will not arrive. Session <code>${escapeHtml(sessionID)}</code> and its history are intact.</p>
    <button id="resume" type="button">Resume session</button>
  </div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      vscode.setState({ sessionID: ${id} });
      document.getElementById("resume").addEventListener("click", function () {
        vscode.postMessage({ source: "amicode", kind: "${RESTORE_RESUME_KIND}" });
      });
    })();
  </script>
</body>
</html>`;
}
