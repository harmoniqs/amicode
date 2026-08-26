# The extension owns all skill loading; user skills are orthogonal to packs and surface tags

Status: accepted (2026-08-26)

External users import their own skills through Skill Providers — directories (or URLs) registered in the Settings UI's Skills tab and persisted to `~/.amico/amicode/skill-providers.json`. The extension suppresses the opencode engine's auto-discovery (`OPENCODE_DISABLE_EXTERNAL_SKILLS=true`) and takes full ownership of skill resolution: if a skill is not visible in the Skills tab, it does not load. User skills are orthogonal to Domain Packs (they never claim pack membership) and sidestep the `surface` tag model (which governs Harmoniqs distribution tiers, not user extensibility).

**Why:** The engine's implicit auto-load paths (`~/.claude/skills/`, `~/.agents/skills/`) create a split-brain: skills load without appearing in the extension's curated Skill Index, and users have no single surface to audit what's active. The `surface: public | internal` model serves Harmoniqs' own distribution control and is meaningless ceremony for a user's personal workflow skill. Domain Packs are "tightly integrated code" by definition (ADR-0008) — user-contributed skills are inherently loose and unvetted, making pack membership a category error. A Settings UI gives explicit consent (no surprise loading), a single audit surface, and discoverability that "drop a folder and hope" cannot.

**Considered:** (a) silently integrating engine auto-load paths into the Skill Index (rejected — loads skills the user doesn't expect, no consent model); (b) requiring user skills to carry `surface: public` (rejected — surface is a Harmoniqs distribution concern, not a user extensibility gate); (c) defining a single `~/.amico/skills/` canonical path without UI (rejected — fragments the story further, power-user-only, no audit surface).

**Key decisions:**
- Resolution precedence: custom providers > workspace (`.opencode/skills/`) > shipped (bundle + team vault).
- Name conflicts: user wins (shadow semantics, first match by name). Shadowed skills are suppressed from the Skill Index.
- Workspace provider (`.opencode/skills/`): auto-loads as read-only — repo-committed skills represent team consensus and need no per-user opt-in.
- Autodiscover: an explicit button scanning known engine paths; results shown for user selection, not silently adopted.
- URL providers: fetch on session start, cache to `~/.amico/amicode/skill-cache/<id>/`, fall back to cache when offline.

**Flip condition:** if a formal Skill marketplace or registry emerges, the provider model becomes its local cache layer rather than the primary registration path.
