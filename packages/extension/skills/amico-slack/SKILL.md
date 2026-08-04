---
name: amico-slack
description: Interacting with Slack — sending updates, reading channel discussions/threads, formatting equations into Slack Unicode/mrkdwn, and managing Slack messages on Aaron's behalf.
agents: [researcher, pulse-designer, librarian]
surface: public
cli_tool: ~/.local/bin/amico-slack
---

# Slack Interaction Skill (`amico-slack`)

Use this skill when reading channel discussions, sending updates to Harmoniqs Slack, formatting messages, or posting updates on Aaron's behalf.

## Core Rules & Best Practices

1. **User Mentions & Tagging (MANDATORY)**:
   - **Always write `@handle` or `@FirstName`** (e.g. `@jackson`, `@kate`, `@nguyen`, `@jack`, `@boyar`, `@jj`) when addressing or notifying a teammate.
   - `amico-slack` automatically resolves `@handles` and `@FirstNames` into Slack's `<@UserID>` format to trigger notifications.
   - **Never write bare names like "Jackson"** when pinging someone — write `@jackson` so they actually get tagged!
   - To search or verify handles/IDs, use `amico-slack whois [name]`.

2. **Hyperlinks in Slack mrkdwn (MANDATORY)**:
   - Standard markdown links `[text](url)` **DO NOT WORK** in Slack!
   - **Always use Slack mrkdwn link format:** `<URL|display text>`
     - Example: `<https://github.com/harmoniqs/amico-plugin/pull/49|PR #49>`
     - Example: `<https://news.fnal.gov/...|Fermilab press release>`
   - For raw URLs without labels: `<https://example.com>`

3. **Slack mrkdwn & LaTeX Formatting**:
   - Slack **does not** render LaTeX math (`$...$` or `$$...$$`).
   - Use `amico-slack` CLI which converts LaTeX equations to clean Unicode & mrkdwn automatically:
     - `$F = 0.99995$` $\to$ `F = 0.99995`
     - `$1.17 \times 10^{-6}$` $\to$ `1.17 × 10⁻⁶`
     - `$\gamma = 3 \times 10^{-3}$` $\to$ `γ = 3 × 10⁻³`
     - `$\Omega$`, `$\delta$`, `$\hbar$` $\to$ `Ω`, `δ`, `ℏ`
   - Bold uses single asterisks `*bold*` (NOT `**bold**`).
   - Italics uses single underscores `_italics_` (NOT `*italics*`).
   - Strikethrough uses tildes `~strikethrough~`.
   - Code blocks use triple backticks ` ```code``` `.

4. **Subtext Attribution & File Passing (`--as-user`)**:
   - When posting on Aaron's behalf, pass `--as-user` to `amico-slack send`.
   - It appends a subtle `_Authored by Amico_` context block at the bottom of the message.
   - For long/multiline text or text containing backticks/quotes, **always pass the message via a temporary file** (`--file /tmp/msg.txt`) to avoid shell backtick/quote expansion bugs.
   - Example:
     ```bash
     amico-slack send "#calibration" --file /tmp/cal_update.txt --as-user
     ```

5. **Threaded Discussions**:
   - When replying to an existing conversation, pass `--thread <ts>` to reply in-thread and avoid cluttering the main channel.
   - Read threads: `amico-slack read "#channel" --thread <ts>`

6. **Bot Status**:
   - Check Slack daemon connection:
     ```bash
     amico-slack status
     ```

## CLI Reference Table

| Task | Command |
|---|---|
| Send update as Aaron (from file) | `amico-slack send "<channel>" --file <file> --as-user` |
| Send update as Aaron (text) | `amico-slack send "<channel>" "<message>" --as-user` |
| Send update in thread | `amico-slack send "<channel>" --file <file> --thread <ts> --as-user` |
| Send update as Bot | `amico-slack send "<channel>" "<message>"` |
| Read channel history | `amico-slack read "<channel>" [limit]` |
| Read thread replies | `amico-slack read "<channel>" --thread <ts>` |
| Search / verify team users | `amico-slack whois [name]` |
| Delete message | `amico-slack delete "<channel>" <ts> [--as-user]` |
| Check status | `amico-slack status` |
