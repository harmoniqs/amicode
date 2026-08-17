# ADR 0008: Server URL Push on Restart

## Status

Accepted

## Context

The Amicode extension embeds the opencode web app in a WebviewPanel iframe. The
iframe's `location.origin` IS the server URL (e.g., `http://127.0.0.1:43117`).
When the server restarts, two scenarios exist:

1. **Same port** (the default, `amicode.opencodePort = 43117`): the iframe's origin
   is still valid. The SSE reconnect loop retries every 250 ms and reconnects once
   the server is back. The server's `server.connected` event carries a `bootId` that
   the web app uses to detect the restart and trigger a full state refresh.

2. **Different port** (ephemeral mode, `amicode.opencodePort = 0`): the iframe's
   origin points to a dead port. The SSE loop fails indefinitely. The webview's
   localStorage may hold a stale URL from the previous port, compounding the issue.

Previously, there was no mechanism for the extension host to notify the webview of
a server restart or URL change. The webview relied entirely on the SSE reconnect
loop and localStorage, both of which fail when the port changes.

## Decision

### Extension host (this repo)

1. **`ChatPanel.notifyServerUrlChanged(url)`**: a static method that checks whether
   the new URL's origin differs from the panel's recorded origin.
   - If same origin: posts a `server-url-changed` message (Lane 2) to all live
     panels as a "restart happened" signal.
   - If different origin: returns `true`, signaling the caller to dispose and
     recreate the panel.

2. **`ChatPanel.disposeCurrent()`**: disposes the underlying `vscode.WebviewPanel`,
   which triggers cleanup and allows `openOrReveal` to create a fresh panel with the
   new iframe `src`.

3. **`serverManager.onReady` hook**: after every successful server start (including
   restarts), calls `notifyServerUrlChanged`. If recreation is needed, disposes the
   panel before `openOrReveal` creates a fresh one.

4. **Lane 2 allowlist**: `"server-url-changed"` added to the relay script's Lane 2
   filter in both `chat_panel.ts` and `deck/shell.ts`.

### Web app (opencode repo)

5. **`AmicodeServerBridge` component**: listens for `server-url-changed` messages.
   If the URL in the message differs from `location.origin` (unexpected — the panel
   should have been recreated), redirects to the new URL as a safety net. If same
   origin, does nothing (the SSE loop handles it).

## Consequences

- Same-port restarts (the common case) are seamless: the SSE loop reconnects and
  the boot-ID mismatch triggers a full refresh — no panel recreation needed.
- Port-change restarts (ephemeral mode) cause a brief panel flicker as the old
  panel is disposed and a new one is created with the correct origin.
- The `onReady` approach covers ALL server-ready events, not just explicit restarts
  — including the initial boot, solver-mode switches, and vault respawns.
- Future improvement: self-healing via `postMessage` (documented in
  `plans/followup-self-healing-reconnect.md` in the workspace) to avoid panel
  recreation entirely.
