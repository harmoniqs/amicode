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
- In devcontainer contexts, the `asExternalUri` translation ensures the iframe src
  uses the host-accessible forwarded port regardless of VS Code's auto-forwarding
  behavior. The extension↔webview heartbeat provides recovery if forwarding is
  severed mid-session.

## Port Forwarding Awareness (WI-1)

In a devcontainer, the extension runs inside the container (`extensionKind:
["workspace"]`) but the webview panel renders on the host. The server's internal
URL (`http://127.0.0.1:43117`) may not be directly accessible from the host — VS
Code's port forwarding can map it to a different host port (e.g., 43118).

The `onReady` handler now resolves the server URL through
`vscode.env.asExternalUri()` before passing it to `ChatPanel` or `DeckPanel`. This
API translates a container-internal URI to the host-accessible forwarded URI:

- In local dev (no remote): identity (no change)
- In devcontainer with identity forwarding: identity
- In devcontainer with remapped forwarding: returns the actual forwarded port
- In Codespaces: returns the cloud-accessible URL

The extension maintains two URLs:
- `opencodeReadyUrl`: the container-internal URL, used by the extension's own SSE
  client, health checks, and API calls (same network namespace, no forwarding needed)
- `opencodeExternalUrl`: the host-accessible URL, used for all webview-facing
  contexts (iframe src, `notifyServerUrlChanged` comparison, panel creation)

The `notifyServerUrlChanged` comparison uses the external URL, ensuring origin
comparison is correct in devcontainer contexts where the iframe's actual origin is
the forwarded port.

## Webview Health Heartbeat (WI-4)

A 30-second heartbeat mechanism between the extension host and the webview relay
script detects when the webview panel is unreachable (e.g., port forwarding severed
mid-session, iframe load failure):

1. The extension posts `{ source: "amicode", kind: "ping" }` to the panel every 30s.
2. The relay script (outer webview `<script>`) responds with
   `{ source: "amicode", kind: "pong", healthy: <bool> }` where `healthy` reflects
   whether the iframe's `contentWindow` is accessible.
3. If no pong arrives within 5 seconds, or pong reports `healthy: false`, the
   extension marks the panel unhealthy.
4. On unhealthy detection: the extension shows a warning notification offering to
   recreate the panel. "Recreate Panel" disposes the current panel and creates a
   fresh one with a new `asExternalUri` call (which may re-trigger port forwarding).
5. On recovery (pong returns healthy): the extension clears the warning state.

This provides a recovery path for mid-session forwarding loss that the SSE loop
alone cannot address (the SSE loop runs inside the iframe, which is unreachable
when forwarding is severed).
