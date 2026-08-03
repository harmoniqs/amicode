# Bug sessions are machine-managed: archived on filing, deleted on abandon

Status: accepted (2026-08-03)

Tracked by: harmoniqs/amicode#249

The Report-a-Bug entry point spawns a **bug session** — a single-purpose Session pre-armed with the `report-a-bug` skill, hosted in a collapsible dock above the composer (a member of the app's todo-dock family, its body an iframe pinned to the session's route). Unlike every other Session, its lifecycle is machine-managed: when the skill files the issue (signaled by a terminal sentinel line in the session's message stream), the dock auto-closes and the session is archived; if the user closes the dock before filing, the session is aborted and hard-deleted. Collapsing the dock is not closing: the chevron shrinks it to its bar and keeps the session alive; only the close control (or filing) ends it. Bug sessions are kept out of the Project's session history in every state.

**Why:** the bug session is a capture device, not a conversation — its value is the filed issue, and leaving ephemeral capture sessions in history would clutter the Project's session list with half-finished drafts. Deleting on abandon is safe because nothing of value exists until filing (the confirm-gate draft is rebuilt cheaply, not resumed), while archiving on filing keeps the transcript restorable as provenance for what diagnostics were attached and what the dedup search found. The sentinel (an `AMICODE_BUG_FILED` line printed by the skill after filing, mirroring the run-telemetry idiom) gives the lifecycle a deterministic trigger that works on both the `gh` and browser-fallback filing paths.

**Considered:** deleting filed sessions too (rejected — the transcript is the only record of what diagnostics were attached and what was edited at the confirm gate; provenance beats maximal ephemerality); no auto-close, an end-card waiting for the user to dismiss (rejected — adds a click at the exact moment the flow should feel finished); archiving abandoned sessions like filed ones (rejected — an abandoned capture has no artifact worth restoring, and invisible accumulation is how history gets noisy); detecting filing by parsing tool calls or server-event payloads (rejected — fragile against the browser-fallback path, and part text is not reliably on the event bus).

**Accepted costs:** closing a surface now means deleting a session on this one dock — the opposite of everywhere else in the app, so the dock's two affordances must stay unambiguous (chevron collapses and keeps alive, the close control kills); the skill gains a terminal-line contract that any future rewrite must preserve; in-flight bug sessions need a metadata marker plus a list filter to stay out of history before reaching their terminal state.

**Flip condition:** if users start treating bug sessions as real conversations (continuing past filing, or expecting drafts to survive), revisit toward archive-always and a visible drafts list.
