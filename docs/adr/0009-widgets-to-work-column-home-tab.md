# Widgets move to the Work Column as the "Home" tab; the standalone home page is retired

Status: proposed (2026-08-24)

Glossary update: `CONTEXT.md` (Home, Widget)

The widget grid — profile cards, run status, problem summaries, and custom agent-authored widgets — relocates from the standalone home page into the Work Column as an always-present first tab labeled "Home". The home page route and its dedicated rendering surface are deleted. The widget kernel (WidgetGrid, WidgetFrame, bridge protocol, `/amicode/widgets` + `/amicode/dashboard` endpoints, the `amicode_author_widget` tool, and the TOML manifest system) is reused in full.

**Why:** Two problems converged. (1) The home page was a dead-end surface: navigating to it meant leaving the session, and returning to the session meant leaving your dashboard — researchers never saw their widgets while working. (2) The Work Column is already the unified auxiliary surface (ADR 0006 moved inspectors there for the same reason); widgets are session-contextual status that belongs in the same hierarchy, always a tab-click away during a conversation.

**Conditions of acceptance:** The Home tab renders first in the tab strip, is always present (never closeable), and is the default-active tab when the panel opens. The 2-column widget grid (heroes full-width, tiles 2-across) works at panel widths down to ~300px, collapsing to single-column below that. The add-widget tray renders as a compact name+description list (no live iframe previews). Drag-reorder (Move mode) functions vertically. The "Pin to dashboard" button in the chat preview card is relabeled "Pin to Home". The home page route no longer exists at runtime. All existing widget tests pass unchanged.

**Accepted costs:** The widget grid operates in a narrower viewport than it was designed for — at minimum panel width (~320px), tiles are ~145px wide each, which is tight for content-heavy widgets. Authors of existing widgets may want to test at narrow widths. The add-widget tray loses its live-preview cards (the iframe previews that showed each candidate widget running) in favor of a text list — faster to load and scan, but less visually informative.

**Considered:** (A) New `WidgetColumn` component purpose-built for the panel (rejected: duplicates 500+ lines of tested state management — ordering, drag, visibility, config — that WidgetGrid already handles; more work, more risk, same result); (B) WidgetGrid with a `variant="panel"` prop that branches layout conditionally (rejected: turns a 550-line component into a conditional maze; the actual changes needed are small and subtractive — simplify the tray, add a CSS threshold — not a different mode).

**Flip condition:** If the tab strip becomes too crowded with Home always occupying one slot, revisit whether Home should be a collapsible section within the Review tab rather than a top-level tab. If a future full-width surface is needed (e.g., a true dashboard mode when no session is active), the widget kernel can render there too — the backend doesn't care where the frontend mounts the grid.
