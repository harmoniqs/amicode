# Building the Extension in a Devcontainer

How to set up and use a devcontainer for iterative build-test cycles of the
amicode extension and its opencode fork, with workspace state that survives
container rebuilds.

---

## Prerequisites

The container must have the following on PATH:

| Tool | Purpose | Installed by |
|------|---------|-------------|
| `bun` (>= 1.x) | opencode repo install + binary compilation | Dockerfile (`bun.sh/install`) |
| `pnpm` (>= 9.x) | amicode repo install + build orchestration | Dockerfile (`get.pnpm.io`) |
| `node` (>= 20) | esbuild, vsce, general tooling | Dockerfile (via nvm) |

`vsce` is NOT required on PATH — it's resolved via `pnpm exec` from the
extension's devDependencies.

The opencode repo must be the `harmoniqs/opencode` fork (the `opencode:build`
script calls `fetch_opencode.mjs` which expects the fork's lock manifest).
Stock `sst/opencode` will not work.

---

## Workspace Layout

### Model A: Persistent clones (recommended for iterative development)

The workspace directory (`/workspaces/<name>`) persists across container
rebuilds. The repos live inside it as ordinary git clones:

```
/workspaces/<workspace>/
  ├── opencode/          ← git clone of harmoniqs/opencode
  ├── amicode/           ← git clone of harmoniqs/amicode
  ├── artifacts/         ← vsix output directory
  └── .devcontainer/
      ├── devcontainer.jsonc
      └── Dockerfile
```

### Model B: Auto-clone on creation (for fresh setups)

Add a `postCreateCommand` to devcontainer.jsonc that clones the repos if absent:

```jsonc
"postCreateCommand": "bash .devcontainer/setup-repos.sh"
```

Where `setup-repos.sh` is an idempotent script that clones + checks out the
desired branches (see the extended example below).

---

## Minimal Devcontainer Configuration

### `devcontainer.jsonc`

```jsonc
{
  "name": "Amicode Extension Dev",
  "build": {
    "dockerfile": "./Dockerfile",
    "context": "."
  },
  "forwardPorts": [43117],
  "portsAttributes": {
    "43117": {
      "label": "Opencode Server",
      "requireLocalPort": true,
      "onAutoForward": "silent"
    }
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

### `Dockerfile`

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl python3 python3-pip python3-venv wget

USER vscode

# Node (via nvm)
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
RUN ["/bin/bash", "-c", "source ${HOME}/.nvm/nvm.sh && nvm install 24"]

# pnpm (for amicode repo)
RUN curl -fsSL https://get.pnpm.io/install.sh | bash

# bun (for opencode repo)
RUN curl -fsSL https://bun.sh/install | bash
```

---

## The Build-Test Cycle

### Using the Developer Tools UI (recommended)

1. Open Settings → Developer Tools
2. Enable **Devcontainer mode (experimental)**
3. Set the three paths: opencode repo, amicode repo, VSIX output directory
4. Click **Build VSIX** — waits 2-5 minutes on first run, ~60-90s thereafter
5. Right-click the emitted `.vsix` in the file explorer → "Install Extension VSIX"
6. The new build is now active — test as needed
7. Iterate: make changes in either repo, click Build VSIX again, reinstall

### Using the terminal (manual equivalent)

```bash
# From the workspace root, with opencode/ and amicode/ as subdirectories:

# 1. Install opencode dependencies
cd opencode && bun install && cd ..

# 2. Install amicode dependencies
cd amicode && pnpm install && cd ..

# 3. Build extension + opencode binary
cd amicode
NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter amicode build
NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter amicode opencode:build
cd ..

# 4. Package vsix
cd amicode/packages/extension
pnpm exec vsce package --no-dependencies --allow-missing-repository -o /workspaces/<workspace>/artifacts/amicode.vsix
cd ../../..

# 5. Install
code --install-extension /workspaces/<workspace>/artifacts/amicode.vsix
```

---

## What Persists Across What

| Item | Container restart | Container rebuild |
|------|------------------|-------------------|
| Workspace files (repos, artifacts) | Yes | Yes (bind mount) |
| `node_modules` inside repos | Yes | Yes (in workspace) |
| `.pnpm-store` | Yes | Yes (in workspace) |
| Installed VS Code extensions | Yes | No (reinstalled) |
| VS Code settings (machine scope) | Yes | No (rewritten from devcontainer.jsonc) |
| Container-local state (`~/.local/`) | Yes | No |

---

## Troubleshooting

### "Build failed" after changing branches

Stale build artifacts from a previous branch can cause failures. Clean both repos:

```bash
cd opencode && git clean -xfd && cd ..
cd amicode && git clean -xfd && cd ..
```

This deletes `node_modules`, `dist/`, and vendor binaries. The next build will
be slow (full reinstall) but clean.

### `.pnpm-store` taking up space

The `.pnpm-store` directory is a build-time cache populated by `pnpm install`.
It's safe to delete (only slows the next install). It has no role at runtime.

### Port forwarding issues

The devcontainer.jsonc pins port 43117 with `requireLocalPort: true`. If you
still see port mismatch issues (blank chat panel), check the Ports tab in VS Code
and ensure 43117 maps to itself (not to a different port).

---

## Extended Example: Auto-Clone with Branch Pinning

### `setup-repos.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="/workspaces/$(basename "$PWD")"
OPENCODE_BRANCH="${OPENCODE_BRANCH:-local/amicode}"
AMICODE_BRANCH="${AMICODE_BRANCH:-main}"

if [ ! -d "$WORKSPACE/opencode/.git" ]; then
  git clone https://github.com/harmoniqs/opencode.git "$WORKSPACE/opencode"
fi
cd "$WORKSPACE/opencode"
git fetch origin
git checkout "$OPENCODE_BRANCH" 2>/dev/null || git checkout -b "$OPENCODE_BRANCH" "origin/$OPENCODE_BRANCH"
git pull --ff-only origin "$OPENCODE_BRANCH" 2>/dev/null || true

if [ ! -d "$WORKSPACE/amicode/.git" ]; then
  git clone https://github.com/harmoniqs/amicode.git "$WORKSPACE/amicode"
fi
cd "$WORKSPACE/amicode"
git fetch origin
git checkout "$AMICODE_BRANCH" 2>/dev/null || git checkout -b "$AMICODE_BRANCH" "origin/$AMICODE_BRANCH"
git pull --ff-only origin "$AMICODE_BRANCH" 2>/dev/null || true

mkdir -p "$WORKSPACE/artifacts"
echo "==> Repos ready: opencode@$OPENCODE_BRANCH, amicode@$AMICODE_BRANCH"
```

Override branches via environment variables:

```bash
# In .env at the workspace root (picked up by devcontainer.jsonc):
OPENCODE_BRANCH=feat/my-feature
AMICODE_BRANCH=feat/my-feature
```

Add to `devcontainer.jsonc`:

```jsonc
"containerEnv": {
  "OPENCODE_BRANCH": "${localEnv:OPENCODE_BRANCH:local/amicode}",
  "AMICODE_BRANCH": "${localEnv:AMICODE_BRANCH:main}"
},
"postCreateCommand": "bash .devcontainer/setup-repos.sh"
```