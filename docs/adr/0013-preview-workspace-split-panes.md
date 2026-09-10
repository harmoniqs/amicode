# Preview becomes a renderer-preserving multi-file split-pane workspace

Status: amended (2026-09-09)

Tracking: harmoniqs/amicode#940 · Glossary update: `CONTEXT.md` (Preview, Sidebar)

## Decision

Preview remains one outer side-panel tab while becoming a multi-document workspace. Files opened by Sidebar single-click or Chat file pills accumulate as closeable inner tabs. A breadcrumb provides contextual sibling navigation, and dragging an inner tab reorders it, transfers it between panes, or creates a recursive split at a pane edge. The Sidebar remains the project-wide file tree; Preview is not a second file browser.

The workspace is a thin layout shell over the existing Preview renderers. It owns only tab-to-pane assignment, pane geometry, focused-pane state, pane zoom, dirty indicators, and the eight-tab resource limit. Each open file owns one persistent baseline renderer instance. Switching tabs, moving a tab between panes, or switching away from the outer Preview tab preserves that renderer instance rather than reconstructing its document, CodeMirror state, PDF layout, scroll position, or focus.

The outer Preview content remains mounted while another outer tab is selected. It is hidden and inert rather than disposed. The pane canvas may provide CSS-only overflow when recursive minimum geometry exceeds the Work Column, but it does not observe, store, restore, or otherwise control scroll position.

## Why

The single-file companion model (#931) optimized for externally driven, one-file-at-a-time reading. Researchers comparing a script and its output, or a spec and implementation, lost their place whenever the next selection replaced the first. Multi-file work needs retained documents and panes.

The original form of this ADR chose a lifted workspace state store plus a renderer-state hydration adapter. That duplicated ownership already held by `PreviewFileView`, CodeMirror, and the PDF renderer. It introduced a canvas-scroll feedback loop and renderer lifecycle races that broke ordinary scrolling and Markdown editing. Preserving the working renderer instances makes the layout shell smaller and gives each layer one owner.

## Conditions Of Acceptance

- A path has at most one live inner tab across the workspace; re-opening it focuses its existing pane and tab.
- At most eight renderer instances are open. The ninth open requires an explicit close; clean tabs are never silently evicted.
- A live renderer remains intact through inner-tab changes, pane transfer or split, and outer-tab changes. Draft text, local scroll, selection, and loaded content stay with that renderer.
- Dirty state is tab chrome only. Closing a dirty tab offers save, discard, or cancel; the layout shell never stores draft text.
- Drag is the primary path for reorder, transfer, and edge split. A Preview-scoped nested-DnD spike must prove non-interference with outer tabs before that interaction ships.
- Each leaf has a 150px minimum dimension. When the tree exceeds the Work Column, a CSS-only canvas scrolls without persistence or restoration logic.
- Pane zoom and the existing preview/edit controls are pane-scoped. Breadcrumb navigation is added only after tab, renderer, and pane interaction gates pass.
- Double-click-to-open-in-VS-Code and the outer side-panel tab bar remain unchanged.

## Rejected Alternatives

1. **Renderer-state hydration adapter** -- rejected. Capturing and restoring drafts, scroll, and focus creates a second owner for state the renderer already owns.
2. **One active renderer per pane** -- rejected. Inactive tabs lose live editing and view state when their renderer is replaced.
3. **Generic split-pane primitive first** -- deferred. No second surface currently establishes a real reuse boundary.

## Accepted Costs

Keeping renderer instances mounted consumes more memory and background resources than hydration. The workspace therefore caps live tabs at eight and requires explicit closure. Keeping Preview mounted while inactive also retains its renderer resources, but avoids destructive remounting during ordinary navigation.

## Validation

Browser interaction tests are required before a Dev Host build is vendored. They must prove stable Markdown focus after grammar loading, ordinary Preview scrolling, Cmd+S behavior, persistence across outer-tab switches, renderer identity across drag relocation, dirty-close confirmation, and non-interference between Preview and outer-tab DnD. Unit and type tests support but do not replace these gates.

## Flip Condition

If a second surface needs the same renderer-preserving pane behavior, extract only the layout shell after two real uses establish its interface. If eight retained renderers prove insufficient in measured use, revisit the cap with evidence rather than introducing silent eviction or a state adapter.
