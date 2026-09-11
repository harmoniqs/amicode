# ADR 0015: Shiki-backed syntax highlighting with VS Code theme bridge

**Status:** Proposed
**Date:** 2026-09-11
**Deciders:** JJ

## Context

The Preview and Files Changed side-panel tabs use CodeMirror 6 (CM6) for code display. CM6 tokenizes code with lezer grammars and colors it via a `HighlightStyle` that maps lezer tags to Amicode's `--syntax-*` CSS custom properties. This setup has three problems:

1. **Limited language coverage.** Only 7 languages have syntax highlighting (JS/TS/JSX/TSX, Python, JSON, Markdown, CSS, HTML). Julia, Rust, Go, YAML, TOML, shell, and everything else render as plain text.

2. **Wrong colors.** The `--syntax-*` palette is Amicode's own — it doesn't match the user's active VS Code theme. The extension only bridges light/dark mode to the webview; no token color extraction exists. A user with "Dracula" in VS Code sees Amicode's pink-and-green in the side panel.

3. **Wrong tokenization.** VS Code uses TextMate grammars; CM6 uses lezer grammars. These produce different token trees for the same code. A Python decorator might be `meta` in lezer but `entity.name.function.decorator` in TextMate, landing on different color buckets even with an identical palette.

Additionally, the app has three independent highlighting systems (CM6, Shiki for markdown code blocks, Shiki via @pierre/diffs for the legacy diff renderer) that produce different colors for the same token types — notably, function names are pink in CM6 (`--syntax-property`) and blue in Shiki (`--syntax-primitive`).

## Decision

Replace CM6's lezer-based `syntaxHighlighting` extension with a **Shiki-backed decoration layer**, and bridge the user's active VS Code theme token colors to the webview.

### Architecture

1. **Extension-side theme bridge** (`SyntaxThemeBridge`): extracts the active VS Code theme's `tokenColors` — either by matching a Shiki built-in theme name or by reading the theme JSON from the contributing extension's filesystem (include-chain resolution capped at depth 5 with cycle detection). Merges `editor.tokenColorCustomizations` overrides. Posts the resolved theme to the webview via `postMessage({ kind: "syntax-theme" })`.

2. **Webview theme registration**: receives the theme, registers it with Shiki, and exposes it via a reactive signal (`activeVSCodeTheme`). Falls back to the existing `OpenCodeTheme` when no VS Code theme is available.

3. **CM6 `ViewPlugin`** (`ShikiHighlightPlugin`): tokenizes the visible viewport (+ buffer) via Shiki's `codeToTokens()` in a **dedicated** Web Worker (separate from the markdown and @pierre/diffs workers — each consumer owns its own highlighter instance). Converts tokens to CM6 `Decoration.mark()` with inline color styles. Debounces re-tokenization at 150ms during editing.

4. **First-paint bridge**: the existing lezer-based `buildSyntaxHighlightStyle()` remains in the CM6 extension set, providing instant (synchronous) approximate highlighting on editor mount. When the Shiki worker returns its first token set, the Shiki inline-style decorations take visual precedence over the class-based lezer colors. This eliminates any plain-text flash during the async tokenization window.

5. **Lezer coexistence**: lezer grammars stay loaded for bracket matching, code folding, auto-indent, and language-aware selections. `@codemirror/language-data` replaces the manual extension map for broader structural coverage. Languages that Shiki highlights but lezer cannot structurally support (potentially Julia) get correct colors but fall back to CM6's generic bracket/fold behavior.

6. **Consistency unification**: all three Shiki consumers (CM6 decoration worker, markdown worker, @pierre/diffs pool) switch from hardcoded `"OpenCode"` to the active VS Code theme. Theme updates are posted to each worker individually.

## Consequences

**Positive:**
- Code in Preview and Files Changed matches the user's VS Code theme — colors and token boundaries.
- 200+ languages gain syntax highlighting (via Shiki's bundledLanguages).
- All highlighting surfaces in the app use the same theme — no more color mismatches.
- Graceful degradation at every level: first-paint lezer colors → Shiki colors → OpenCodeTheme fallback outside VS Code.

**Negative:**
- Adds a second tokenization pipeline (Shiki) alongside lezer. Lezer can't be removed because CM6 needs it for structural editing features.
- Three independent Shiki highlighter instances (one per worker) increase memory usage, though language grammars are lazy-loaded and only instantiated languages occupy memory.
- Theme extraction from the VS Code extension filesystem is fragile for exotic or deeply-nested theme inheritance chains. Bounded at depth 5 with cycle detection; falls back to OpenCodeTheme on failure.
- Bundle size grows: `@codemirror/language-data` and Shiki's `bundledLanguages` both use dynamic imports (pay-per-language at runtime), but the total importable surface is larger.

**Neutral:**
- The `--syntax-*` CSS custom properties and `OpenCodeTheme` remain as fallback infrastructure — they're no longer the primary path but aren't removed.
- `buildSyntaxHighlightStyle()` stays in the codebase as the first-paint bridge, not just a fallback.
- Lezer structural coverage gaps (languages without a lezer grammar) are a known trade-off: correct colors everywhere, structural features for most languages.

## Linked issue

`issue-shiki-backed-cm6-syntax-highlighting.md` (scratchpad draft — to be published as GitHub issue).
