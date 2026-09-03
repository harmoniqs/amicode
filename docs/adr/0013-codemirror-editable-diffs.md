# CodeMirror 6 replaces @pierre/diffs for editable diffs in Files Changed

Status: proposed (2026-09-03)

Tracking: harmoniqs/amicode#766

The Files Changed panel switches from the read-only @pierre/diffs renderer to CodeMirror 6
for file content display, making the modified ("after") side of diffs editable. CodeMirror 6
is added to the opencode fork's session-ui package as a new `EditableDiffView` component; the
amicode overlay wires it into the review panel and adds the edit-to-context feedback channel.

**Why:** The Files Changed panel is the natural place to correct the agent's output, but
today it is strictly read-only — users who spot a mistake must describe the fix in a comment
or switch to the VS Code editor. Making diffs editable closes the review loop: see the
change, fix it in place, and the agent learns what you corrected via the edit-to-context
system (a synthetic diff included in the next message, mirroring the existing line-comment-
to-context pattern).

**Why CodeMirror 6 over alternatives:** (A) Extending @pierre/diffs with editing was
rejected — it is a Shadow DOM-based read-only renderer with no text editing infrastructure;
retrofitting one would mean building an editor inside a library designed not to be one.
(B) Monaco Editor was rejected — at ~2MB it is an order of magnitude heavier than needed for
a side-panel diff view, and its standalone-editor design fights the embedded context.
CodeMirror 6 (~150KB) is purpose-built for embedded editors, has first-class diff support via
@codemirror/merge, an imperative API that composes with SolidJS, and is the proven choice in
Claude Code's equivalent surface.

**Accepted costs:** A new dependency (~150KB, <=60KB gzipped) in session-ui that did not
exist before. Two rendering paths for file content: @pierre/diffs continues serving inline
code in chat messages and the context tab; CodeMirror serves the review panel. Language
grammar loading for syntax highlighting is separate from Shiki (used by @pierre/diffs) — some
languages may highlight differently between the two. Unified-mode diff decorations (gutter
markers for added/removed/changed lines) are a custom CM6 extension, not provided by
@codemirror/merge out of the box — this is a discrete deliverable.

**Flip condition:** If @pierre/diffs gains editing support upstream, or if a future opencode
release replaces @pierre/diffs with CodeMirror globally, the two-renderer split can be
collapsed.
