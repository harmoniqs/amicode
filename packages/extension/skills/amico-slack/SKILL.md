---
name: amico-slack
description: Interacting with Slack — reading channels, sending messages, searching, and managing reactions via the slack-mcp-server MCP tools.
agents: [researcher, librarian]
surface: public
---

# Slack Interaction Skill (`amico-slack`)

Use this skill when reading channel discussions, sending updates to Slack, formatting messages, or searching conversation history. The tools come from [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server), an MCP server spawned automatically when a Slack credential is stored.

## Connection

If Slack is not connected, the tools will not be available. Guide the user to authenticate:

```
amico slack login
```

This opens a browser to Slack's OAuth consent screen, authenticates the user, and stores the token. Messages are sent **as the user** (not a bot). After login, restart the Amicode server to pick up the new credential.

## Core Rules & Best Practices

1. **Soft preview norm (IMPORTANT)**: Always show the user the message text before calling `conversations_add_message`. This is a conversational norm — present a draft, get confirmation, then send.

2. **User mentions & tagging**: Write `@handle` or `@FirstName` when addressing a teammate. The `slack-mcp-server` resolves handles to Slack user IDs automatically. Use `users_search` to find handles by name or email.

3. **Formatting — standard Markdown, NOT Slack mrkdwn**: The `slack-mcp-server` uses `text/markdown` format:
   - Bold: `**bold**` (not `*bold*`)
   - Italics: `*italics*` (not `_italics_`)
   - Strikethrough: `~~strike~~` (not `~strike~`)
   - Code blocks: triple backticks
   - Hyperlinks: `[display text](URL)` (standard Markdown — not `<URL|display text>`)

4. **LaTeX-to-Unicode conversion (MANDATORY)**: Slack does not render LaTeX. Convert equations to Unicode before sending:
   - `$F = 0.99995$` → `F = 0.99995`
   - `$1.17 \times 10^{-6}$` → `1.17 × 10⁻⁶`
   - `$\gamma = 3 \times 10^{-3}$` → `γ = 3 × 10⁻³`
   - `$\Omega$`, `$\delta$`, `$\hbar$` → `Ω`, `δ`, `ℏ`

5. **Threaded discussions**: When replying to an existing conversation, use the `thread_ts` parameter to reply in-thread and avoid cluttering the main channel.

## MCP Tool Reference

| Task | Tool | Key parameters |
|------|------|----------------|
| Read channel history | `conversations_history` | `channel_id`, `limit` |
| Read thread replies | `conversations_replies` | `channel_id`, `thread_ts`, `limit` |
| Send a message | `conversations_add_message` | `channel_id`, `text`, `thread_ts` (optional) |
| Search messages | `conversations_search_messages` | `query`, `sort` |
| List channels | `channels_list` | `limit` |
| Find users | `users_search` | `query` |
| Get unread messages | `conversations_unreads` | — |
| Add reaction | `reactions_add` | `channel`, `timestamp`, `name` |
| Remove reaction | `reactions_remove` | `channel`, `timestamp`, `name` |
| Mark as read | `conversations_mark` | `channel_id`, `ts` |
| List saved items | `saved_list` | — |

## Notes

- Messages are sent as the authenticated user, not a bot
- Channel IDs can be found via `channels_list` — the agent resolves `#channel-name` to an ID
- DM targets require finding the user via `users_search` first, then opening a conversation
- The `slack-mcp-server` handles pagination, caching, and structured error responses internally
