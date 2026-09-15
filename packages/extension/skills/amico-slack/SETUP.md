# Slack Integration Setup Guide

How to connect Amicode to a Slack workspace so Amico can read messages, search history, and post on your behalf.

## Overview

Amicode talks to Slack through the [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) MCP package. Messages are sent **as you** (user OAuth token), not as a bot. The integration is outbound-only — Amicode calls the Slack Web API when you ask it to; there are no inbound webhooks or event subscriptions.

The setup has four parts:

1. Create a Slack app from a manifest
2. Install the app and copy the User OAuth Token
3. Register the localhost redirect URI (for `amico slack login`)
4. Wire the MCP server into the Amicode config

## Prerequisites

- Admin (or app-install) permissions on the target Slack workspace
- Node.js / npm installed (for `npx` to run the MCP server)
- Amicode installed and running

## Step 1: Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace
3. Paste the contents of [`slack-manifest.json`](./slack-manifest.json) (included in this directory)
4. Click **Next**, review the summary, then **Create**

### About the manifest

The manifest defines a minimal Slack app with:

| Section | What it does |
|---------|-------------|
| `bot_user` | Required by Slack's OAuth install flow — sits idle; you use the user token |
| `bot` scopes | Valid bot-token scopes (everything except `search:read`, which is user-only) |
| `user` scopes | The real permissions — read history, list channels/DMs, post messages, search, resolve users |
| `socket_mode_enabled: false` | No inbound event delivery needed |
| `is_hosted: false` | Not a Slack-hosted app |

**Why both bot and user scopes?**
Slack won't complete the OAuth install without a bot user, and a bot user needs at least one scope. The bot scopes mirror the user scopes minus `search:read` (which isn't valid for bot tokens — putting it there causes validation errors in Slack's manifest editor). In practice, Amicode only uses the **User OAuth Token** (`xoxp-…`).

**Why `search:read` is user-only:**
Slack's API restricts `search:read` to user tokens. If you add it under `bot` scopes, the manifest editor shows red validation errors on every bot scope line and the install fails.

## Step 2: Install and get the User OAuth Token

1. After creating the app, click **Install to Workspace** and authorize
2. Go to **App Settings** → **OAuth & Permissions**
3. Copy the **User OAuth Token** (starts with `xoxp-`)

You do **not** need the Bot Token (`xoxb-`) or App Token (`xapp-`) — those are for the idle bot user.

## Step 3: Register the OAuth redirect URI

When you run `amico slack login`, it starts a local HTTP server to receive the OAuth callback. Slack rejects callbacks to unregistered URIs.

1. In App Settings → **OAuth & Permissions** → **Redirect URLs**, add:
   ```
   http://localhost:54213/callback
   ```
2. Click **Save URLs**

> **Note:** The port (`54213`) may vary between login attempts. If you see a `redirect_uri did not match` error with a different port, add that port's callback URL as well.

## Step 4: Wire the MCP server into Amicode

Add a `slack` entry under `mcp` in your Amicode config (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "slack": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "slack-mcp-server"],
      "env": {
        "SLACK_TOKEN": "<your xoxp- user OAuth token>"
      }
    }
  }
}
```

Replace `<your xoxp- user OAuth token>` with the token from Step 2.

The MCP package is **`slack-mcp-server`** by korotovsky (not `@anthropic/slack-mcp-server`).

## Step 5: Reload and verify

1. Reload the Amicode window: **Cmd+Shift+P** → **Developer: Reload Window**
2. Open a **new chat session** (the + button)
3. Ask Amico to send a test message, e.g.: *"message @someone in Slack saying hello"*

If the MCP server loaded correctly, Amico will have access to tools like `users_search`, `conversations_add_message`, `conversations_history`, and `channels_list`.

## Available Slack tools

Once connected, these tools are available in every session:

| Task | Tool | Key parameters |
|------|------|----------------|
| Read channel history | `conversations_history` | `channel_id`, `limit` |
| Read thread replies | `conversations_replies` | `channel_id`, `thread_ts`, `limit` |
| Send a message | `conversations_add_message` | `channel_id`, `text`, `thread_ts` (optional) |
| Search messages | `conversations_search_messages` | `query`, `sort` |
| List channels | `channels_list` | `limit` |
| Find users | `users_search` | `query` |
| Get unread messages | `conversations_unreads` | — |
| Add/remove reaction | `reactions_add` / `reactions_remove` | `channel`, `timestamp`, `name` |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Install fails silently ("Click Create and Install to try again") | Make sure the manifest has a `bot_user` block and `is_hosted: false` in settings |
| Red squiggles on all bot scopes in manifest editor | Remove `search:read` from `bot` scopes — it's user-token-only |
| `redirect_uri did not match` error on login | Add the exact `http://localhost:<port>/callback` URL from the error to OAuth & Permissions → Redirect URLs |
| Slack tools not available in session | Check that the `mcp.slack` block is in `~/.config/opencode/opencode.json`, then reload the window and start a **new** session |
| Messages sent as bot instead of as you | Make sure you're using the User OAuth Token (`xoxp-`), not the Bot Token (`xoxb-`) |

## File reference

| File | Location | Purpose |
|------|----------|---------|
| `slack-manifest.json` | This directory | Slack app manifest — paste into api.slack.com to create the app |
| `SKILL.md` | This directory | The amico-slack skill — tool reference and formatting rules |
| `opencode.json` | `~/.config/opencode/opencode.json` | Amicode config — where the MCP server is registered |
