// amicode (#174): pure decisions behind the status popover's two mounts —
// the session-header trigger and the home-chrome Connections entry. Kept
// JSX-free so the policy is unit-testable (the repo has no tsx harness).

/**
 * Session-header trigger policy (#174 AC2).
 *
 * The status popover hosts the global Connections + Vaults tabs, so the
 * trigger is the only per-session entry to global credential config. It
 * therefore renders whenever a session is open. The "Server status" desktop
 * setting (settings.general.showStatus, default OFF) is scoped DOWN to the
 * health-dot overlay only: its UI copy sells server health, not access to
 * configuration, and hiding the whole button orphaned Connections/Vaults on
 * every default-settings install.
 */
export function statusTriggerVisibility(input: { desktopV2: boolean; showStatus: boolean }): {
  trigger: boolean
  healthDot: boolean
} {
  return {
    trigger: true,
    // The setting exists only on the desktop v2 chrome; elsewhere the dot
    // keeps its historical always-on behavior.
    healthDot: input.desktopV2 ? input.showStatus : true,
  }
}

/**
 * Home-chrome (global) surface (#174 AC1): the same Vaults + Connections tabs
 * the session popover hosts — and ONLY those. The mcp/lsp/plugins tabs are
 * per-directory (they read the directory-scoped sync context, which the home
 * route does not mount) and are meaningless before a session exists.
 */
// amicode#202: vaults moved to the native Armonia sidebar panel, so the
// global home-chrome surface hosts Connections only.
export const GLOBAL_STATUS_TABS = ["connections"] as const
export type GlobalStatusTab = (typeof GLOBAL_STATUS_TABS)[number]

/** The home entry is labeled "Connections", so that tab opens pre-selected. */
export const GLOBAL_STATUS_DEFAULT_TAB: GlobalStatusTab = "connections"

/**
 * Popover anchoring (amicode#105): bottom-end with the standard gutter and the
 * library's default collision handling — NEVER a hardcoded `shift`. The
 * shift={-168} magic offset positioned the panel by guesswork: it clipped
 * off-anchor at narrow widths and could not adapt to the viewport. Deleting it
 * is the fix; the AC is that it stays deleted (popover_magic_shift == 0).
 */
export function statusPopoverLayout(): { placement: "bottom-end"; gutter: number } {
  return { placement: "bottom-end", gutter: 4 }
}
