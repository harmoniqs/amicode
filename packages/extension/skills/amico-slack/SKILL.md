---
name: amico-slack
description: Interacting with Slack via MCP tools — reading channels/threads, sending messages, listing channels and users, formatting equations into Slack Unicode/mrkdwn.
agents: [researcher, pulse-designer, librarian]
surface: public
---

# Slack Interaction Skill (`amico-slack`)

Use this skill when reading Slack channels or threads, sending messages, listing channels or looking up users. All Slack operations go through three MCP tools: `amicode_slack_read`, `amicode_slack_send`, and `amicode_slack_list`.

## Bot Identity

Messages sent via `amicode_slack_send` always post as the Slack bot. There is no impersonation mode. If the user wants a message to appear from their own account, draft the text for them to copy-paste manually.

## Core Rules

### 1. Preview before sending

Show the user the full message text before calling `amicode_slack_send`. This is a best practice — let them confirm wording, tone, and recipients before it goes out.

### 2. @handle mentions

Write `@handle` (e.g. `@jackson`, `@kate`, `@jj`) when tagging someone. `amicode_slack_send` resolves `@handle` patterns to Slack's `<@UserID>` format server-side — just write the `@handle` in the text and the tool handles resolution.

Never write bare names like "Jackson" when pinging someone — always use `@jackson` so they get notified.

If you need to verify a handle, use `amicode_slack_list` with `kind: "users"` and `query: "name"`.

### 3. Slack mrkdwn formatting

Slack uses its own markup — not standard markdown. Follow these rules:

- **Hyperlinks:** `<URL|display text>` — standard markdown `[text](url)` does NOT work in Slack.
  - `<https://github.com/harmoniqs/amicode/pull/391|PR #391>`
  - Raw URL without label: `<https://example.com>`
- **Bold:** `*bold*` (single asterisks, NOT `**bold**`)
- **Italics:** `_italics_`
- **Strikethrough:** `~strikethrough~`
- **Code blocks:** triple backticks `` ```code``` ``

### 4. LaTeX-to-Unicode conversion

Slack does not render LaTeX (`$...$` or `$$...$$`). The MCP tools do NOT convert LaTeX automatically — you must convert all math to Unicode before sending. Examples:

| LaTeX | Unicode |
|---|---|
| `$F = 0.99995$` | `F = 0.99995` |
| `$1.17 \times 10^{-6}$` | `1.17 × 10⁻⁶` |
| `$\gamma = 3 \times 10^{-3}$` | `γ = 3 × 10⁻³` |
| `$\Omega$` | `Ω` |
| `$\delta$` | `δ` |
| `$\hbar$` | `ℏ` |
| `$\hat{H}$` | `H` (drop the hat or use `Ĥ` if critical) |

Use Unicode superscripts (`⁰¹²³⁴⁵⁶⁷⁸⁹⁻`) for exponents and Greek letters for symbols. When in doubt, spell it out plainly — clarity beats decoration.

### 5. Error handling

The tools return structured errors. Handle them:

| Error | Meaning | Action |
|---|---|---|
| `not_connected` | Slack integration is not configured | Tell the user to connect Slack in Amicode settings |
| `rate_limited` | Hit Slack's API rate limit | Wait a moment and retry |
| `not_in_channel` | The bot is not a member of the target channel | Ask the user to invite the bot to the channel |

## MCP Tool Reference

| Task | Tool | Parameters |
|---|---|---|
| Read channel history | `amicode_slack_read` | `target: "#channel"` |
| Read a thread | `amicode_slack_read` | `target: "#channel"`, `thread_ts: "1234567890.123456"` |
| Read DMs (all recent) | `amicode_slack_read` | `target: "dms"` |
| Read DMs with a user | `amicode_slack_read` | `target: "@user"` |
| Send a message | `amicode_slack_send` | `target: "#channel"`, `text: "message"` |
| Reply in a thread | `amicode_slack_send` | `target: "#channel"`, `text: "message"`, `thread_ts: "1234567890.123456"` |
| List channels | `amicode_slack_list` | `kind: "channels"` |
| Search/list users | `amicode_slack_list` | `kind: "users"`, `query: "name"` |
