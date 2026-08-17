# Devcontainer Configuration

This document covers how the Amicode extension's runtime invariants (server port,
storage paths, etc.) are configured in devcontainer environments, including the
Dockerfile-based build case.

---

## Why port stability matters

The Amicode webview panel embeds the opencode web app in an iframe served by a
local HTTP server. The webview's localStorage (which persists session tabs, project
paths, and connection state) lives on the **host machine** — it survives container
rebuilds. The server port, however, is ephemeral unless explicitly pinned.

If the server starts on a different port after a container rebuild, the persisted
connection state in localStorage is stale. The webview's SSE event stream connects
to the dead port, and the user sees no responses until localStorage is cleared.

**The fix:** pin the server port to a stable value (default: `43117`) so that the
persisted URL remains valid across container rebuilds.

---

## Use cases

### A. Pre-built extension (marketplace install)

The devcontainer installs Amicode from the VS Code Marketplace. No build-time
dependencies are needed.

```jsonc
// .devcontainer/devcontainer.json
{
  "name": "Amicode",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "customizations": {
    "vscode": {
      "extensions": ["harmoniqs.amicode"],
      "settings": {
        "amicode.opencodePort": 43117
      }
    }
  }
}
```

The `amicode.opencodePort` setting is read by the extension at startup. It passes
`--port 43117` to the spawned `opencode serve` process. This is the simplest
configuration and covers most users.

### B. Dockerfile-based build (extension under development)

The devcontainer uses a Dockerfile that installs build-time dependencies (Node,
pnpm, Bun, etc.). The extension is NOT installed from the marketplace — it runs
via F5 ("Run Extension") or is manually installed from a locally-built `.vsix`.

```jsonc
// .devcontainer/devcontainer.json
{
  "name": "Amicode Dev",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "customizations": {
    "vscode": {
      "settings": {
        "amicode.opencodePort": 43117
      }
    }
  }
}
```

**Key point:** `customizations.vscode.settings` is applied to the VS Code instance
regardless of how extensions are installed. Even when the extension is launched via
F5 (Extension Development Host), VS Code resolves `amicode.opencodePort` from the
workspace/container settings. You do NOT need the extension to be listed in
`"extensions"` for the setting to be available.

If the Dockerfile needs to set a default port for cases where VS Code is not
involved (e.g., running `opencode serve` directly in a terminal during
development):

```dockerfile
# Dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# ... build-time dependencies ...

# Default server port for opencode (read via OPENCODE_CONFIG_CONTENT)
ENV OPENCODE_CONFIG_CONTENT='{"server":{"port":43117}}'
```

This env var is read by the opencode binary directly, bypassing VS Code settings.
It works in all contexts — terminal, scripts, CI — but note that when the Amicode
extension IS running, it builds its own `OPENCODE_CONFIG_CONTENT` (merging
instructions, permissions, telemetry, etc.) and passes it to the server process.
The Dockerfile's `ENV` value is therefore only effective when running the binary
manually outside the extension.

### C. CI / headless (no VS Code)

For test harnesses, build pipelines, or headless environments where VS Code is not
present:

**Option 1 — `opencode.json` in the project root:**
```json
{
  "server": {
    "port": 43117
  }
}
```

This is the most portable option. The opencode binary reads it from the working
directory (or any ancestor). It works in all contexts and requires no environment
variable management.

**Option 2 — `OPENCODE_CONFIG_CONTENT` env var:**
```bash
export OPENCODE_CONFIG_CONTENT='{"server":{"port":43117}}'
opencode serve
```

Or in `docker-compose.yml`:
```yaml
services:
  opencode:
    environment:
      OPENCODE_CONFIG_CONTENT: '{"server":{"port":43117}}'
```

**Option 3 — CLI flag:**
```bash
opencode serve --port 43117
```

---

## Port resolution priority (highest wins)

| Priority | Mechanism | Who sets it |
|----------|-----------|-------------|
| 1 | `--port` CLI flag | The extension (internally) or manual invocation |
| 2 | `OPENCODE_CONFIG_CONTENT` env var | The extension (builds merged config) or Dockerfile `ENV` |
| 3 | `opencode.json` `server.port` field | Developer, committed to repo |
| 4 | Default: `0` → try 4096, then OS-assigned | Built-in fallback |

When the Amicode extension is running:
- It reads `amicode.opencodePort` from VS Code settings (default: `43117`)
- It passes this as `--port` to the spawned server (priority 1)
- All other mechanisms are fallbacks for when the extension is not present

---

## Other configurable paths

The extension also supports overriding storage locations via VS Code settings
(added in #378):

| Setting | Env var injected | Default (XDG) |
|---------|-----------------|---------------|
| `amicode.sessionDatabase` | `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` |
| `amicode.configDir` | `OPENCODE_CONFIG_DIR` | `~/.config/opencode` |

These can also be set in `customizations.vscode.settings` in `devcontainer.json`
for container-specific overrides (e.g., placing the database on a mounted volume).

---

## Caveats for Dockerfile-based builds

1. **The extension is not installed at image build time.** `customizations.vscode`
   is processed by VS Code/Codespaces at container start, not during `docker build`.
   Do not rely on extension presence in Dockerfile `RUN` steps.

2. **`OPENCODE_CONFIG_CONTENT` conflicts.** If both the Dockerfile sets this env
   var AND the extension is running, the extension's value wins (it spawns the
   server with its own merged config in the process env, overriding the container
   env). The Dockerfile value is only effective for manual `opencode serve` calls.

3. **Port forwarding.** If VS Code auto-forwards port 43117 (which it does by
   default for detected listening ports), the server is accessible from the host at
   `localhost:43117`. This is expected behavior and does not interfere with the
   webview (which connects to the container-internal `127.0.0.1:43117`).

4. **Multiple containers on the same host.** If two devcontainers both use port
   43117, VS Code handles port forwarding conflicts (it maps to different host
   ports). The webview inside each container connects to its own `127.0.0.1:43117`
   without conflict. The localStorage isolation concern (multiple webviews sharing
   one localStorage scope) is separate and addressed by the boot-ID mechanism
   (opencode ADR 0005).
