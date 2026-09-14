# Connection-to-agent bridge via MCP tools, not standalone CLIs

Status: accepted

Connections bridge to agent-usable operations through MCP servers spawned by the config builder (ADR 0002) — the same process that owns the credential store — rather than through standalone CLI binaries that read credential files from disk independently. The Slack integration is the first instance; the pattern extends to any Connection that needs an agent-facing API.

**Revised approach (2026-09-14):** The original plan (three custom `amicode_slack_*` tools in the fork server) was implemented and reverted. The accepted approach uses an existing MCP server package (`slack-mcp-server`) spawned as a child process by the config builder when a credential exists, with the token threaded as a single environment variable (minimal-env graft). An OAuth PKCE login command (`amico slack login`) writes the credential to the existing store; the config builder reads it at server spawn time. No custom Slack API code in the server process.

**Why:** three approaches were evaluated. (1) MCP tools in the server — the server already owns the credential via `readCredential()`, the existing MCP tool surface is the agent contract, and tools appear automatically with no install step. (2) A standalone CLI binary reading the credential file from disk — this was attempted for Slack (`amico-slack`), committed once, and never reliably shipped; it requires a separate install/update mechanism, a separate discovery path (`which`), and a separate failure surface; the fleet digest fell back to raw `curl`, the papers digest built a third path. (3) An HTTP proxy — the server exposes routes, a thin CLI delegates — over-engineered for v1 when the primary consumer is the agent.

**Considered and rejected:** the CLI pattern (approach 2) — the `amico-slack` binary was committed (`c6f64d20`) but never planted reliably on machines; three disconnected Slack credential stores emerged (`slack.json`, `slack/token`, the CLI's own path); the pattern failed to ship across the fleet. The HTTP proxy (approach 3) — clean architecture but unnecessary indirection when no non-agent consumer needs the bridge today; fleet scripts keep their own `curl` paths.

**Accepted costs:** operations that run outside the agent (fleet scripts, Notturno jobs) cannot use MCP tools and keep their own credential paths. Three Slack code paths now coexist (MCP tools, fleet `curl`, the legacy committed-but-unshipped CLI reference) rather than converging. This decision couples to ADR 0002's credential-seam placement — if 0002 flips and the credential seam moves out of the server process, this pattern loses its foundation.

**Flip condition:** revisit toward approach 3 (HTTP routes on the same server) if non-agent consumers (fleet scripts, Notturno jobs, external tooling) need the same Connection-backed capabilities, or if ADR 0002 flips and the credential seam moves out of the server process.

**Implementation:** see #1037 (Slack MCP tools — revised approach), #1156 (OAuth login), #1157 (config builder bridge), #1041 (SKILL.md rewrite).
