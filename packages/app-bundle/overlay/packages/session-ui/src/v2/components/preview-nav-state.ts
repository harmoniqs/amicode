/**
 * preview-nav-state — Per-file state manager for the Preview tab.
 *
 * Manages mode (preview/edit), scroll position, and unsaved content per file.
 * The Finder navigation state machine has been removed (#933) — the Preview
 * tab is now a companion viewer driven by external file selection (sidebar,
 * chat pills), not its own browser.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreviewFileState {
  mode: "preview" | "edit"
  scrollPosition: number
  unsavedContent: string | null
}

// ---------------------------------------------------------------------------
// Default file state
// ---------------------------------------------------------------------------

const DEFAULT_FILE_STATE: PreviewFileState = {
  mode: "preview",
  scrollPosition: 0,
  unsavedContent: null,
}

// ---------------------------------------------------------------------------
// Per-file state manager (plain object, no reactivity)
// ---------------------------------------------------------------------------

export function createPreviewFileStates() {
  let fileStates: Record<string, PreviewFileState> = {}

  return {
    get(path: string): PreviewFileState {
      return fileStates[path] ?? { ...DEFAULT_FILE_STATE }
    },

    set(path: string, state: PreviewFileState) {
      fileStates = { ...fileStates, [path]: state }
    },

    getAll(): Record<string, PreviewFileState> {
      return fileStates
    },
  }
}
