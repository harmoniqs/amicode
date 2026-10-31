# Slack Integration Setup Guide

How to connect Amicode to a Slack workspace so Amico can read messages, search history, and post on your behalf.

## Overview

Amicode talks to Slack through the [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) MCP package. Messages are sent **as you** (user OAuth token), not as a bot. The integration is outbound-only — Amicode calls the Slack Web API when you ask it to; there are no inbound webhooks or event subscriptions.

The setup has five parts:

1. Create a Slack app from a manifest
2. Copy the app's Client ID and Client Secret
3. Register the localhost redirect URI (for `amico slack login`)
4. Give Amicode the app credentials and run `amico slack login`
5. Verify — the Slack MCP server starts on its own

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
| `bot` scopes | Read-side bot-token scopes plus `chat:write`, so the idle bot user can install (never `search:read`, which is user-only) |
| `user` scopes | The real permissions — read history, list channels/DMs, open DMs and group DMs, post messages, search, resolve users. They match the `USER_SCOPES` that `amico slack login` requests |
| `socket_mode_enabled: false` | No inbound event delivery needed |
| `is_hosted: false` | Not a Slack-hosted app |

**Why both bot and user scopes?**
Slack won't complete the OAuth install without a bot user, and a bot user needs at least one scope. The bot scopes are the user scopes minus `search:read` (which isn't valid for bot tokens — putting it there causes validation errors in Slack's manifest editor) and minus the DM-opening `im:write` / `mpim:write`, which only the user token needs. In practice, Amicode only uses the **User OAuth Token** (`xoxp-…`).

**Why `search:read` is user-only:**
Slack's API restricts `search:read` to user tokens. If you add it under `bot` scopes, the manifest editor shows red validation errors on every bot scope line and the install fails.

## Step 2: Copy the app credentials

1. In the app's settings, open **Basic Information** → **App Credentials**
2. Copy the **Client ID** and the **Client Secret**

Slack's `oauth.v2.access` exchange needs both, even under PKCE. You do **not** copy a token by hand: `amico slack login` (Step 4) obtains your User OAuth Token (`xoxp-…`) itself. You never need the Bot Token (`xoxb-`) or an App Token (`xapp-`) — those belong to the idle bot user.

## Step 3: Register the OAuth redirect URI

When you run `amico slack login`, it starts a local HTTP server to receive the OAuth callback. Slack rejects callbacks to unregistered URIs.

1. In App Settings → **OAuth & Permissions** → **Redirect URLs**, add:
   ```
   http://localhost:54213/callback
   ```
2. Click **Save URLs**

> **Note:** The port is fixed at `54213`. If something else is listening on it, `amico slack login` reports that the port is in use; close the other process and retry.

## Step 4: Give Amicode the app credentials, then log in

`amico slack login` reads the app credentials from, in priority order:

1. the environment — `AMICODE_SLACK_CLIENT_ID` and `AMICODE_SLACK_CLIENT_SECRET`, or
2. `~/.amico/slack-app.json` — `{ "client_id": "…", "client_secret": "…" }` (mode 600). **Settings → Connections → Slack** in Amicode writes this file for you.

Then run:

```bash
amico slack login
```

It opens your browser at Slack's authorize page (PKCE, user scopes only). Approve it, and the callback on `http://localhost:54213/callback` exchanges the code for your User OAuth Token (`xoxp-…`) and writes it to `~/.amico/slack.json` (atomic, mode 600; `AMICO_SLACK_FILE` overrides the path). The flow times out after 120 seconds if no callback arrives.

You do not edit `opencode.json` or paste a token anywhere.

## Step 5: Verify

1. Amicode watches `~/.amico/slack.json`. When the file appears, the extension adds the `slack` MCP server (`npx -y slack-mcp-server`, by korotovsky — not `@anthropic/slack-mcp-server`) to the running engine on its own. If that live add fails, it restarts the server instead. Deleting the file removes the server.
2. Open a **new chat session** (the + button). Sessions that were already open do not pick up the new tools.
3. Ask Amico to send a test message, for example: *"message @someone in Slack saying hello"*.

If the MCP server loaded, Amico has tools like `users_search`, `conversations_add_message`, `conversations_history`, and `channels_list`. If not, check the **Amicode** output channel for `[slack]` lines.

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
| `redirect_uri did not match` error on login | Add `http://localhost:54213/callback` to OAuth & Permissions → Redirect URLs |
| `No Slack App configured` / `Client Secret is missing` | Set `AMICODE_SLACK_CLIENT_ID` + `AMICODE_SLACK_CLIENT_SECRET`, or save both via Settings → Connections → Slack (`~/.amico/slack-app.json`) |
| Slack tools not available in session | Check that `~/.amico/slack.json` exists (re-run `amico slack login`), look for `[slack]` lines in the Amicode output channel, then start a **new** session |
| `missing_scope` when sending a DM or group DM | Your app's manifest lacks `im:write` / `mpim:write` under `user` scopes — add them, then re-run `amico slack login` |

## File reference

| File | Location | Purpose |
|------|----------|---------|
| `slack-manifest.json` | This directory | Slack app manifest — paste into api.slack.com to create the app |
| `SKILL.md` | This directory | The amico-slack skill — tool reference and formatting rules |
| `slack-app.json` | `~/.amico/slack-app.json` | Slack app Client ID + Client Secret (or use the `AMICODE_SLACK_CLIENT_*` env vars) |
| `slack.json` | `~/.amico/slack.json` | Your User OAuth Token, written by `amico slack login`; its presence starts the MCP server |
