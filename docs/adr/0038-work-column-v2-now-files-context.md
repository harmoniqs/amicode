# The Work Column becomes Now · Files · Context with global Home · Fleet; widgets become records bound to first-party views

Status: proposed (2026-10-31)

Amends: ADR 0009 (Home as the widget tab), ADR 0006 (inspectors as Work Column tabs). Glossary update: `CONTEXT.md` (Work Column, Now, Files, Context, Home, Widget, Record, View).

Design: `docs/design/sidepanel-v2/SPEC.md`, mocks in the same folder.

## Decision

1. **Five tabs replace today's set.**
   - **Session tabs** (fixed order, not closeable): **Now** (what the session is doing: needs-you, live runs, campaign, casts, compute, watcher, the session's widgets), **Files** (one workspace merging Files Changed, the file tree, Preview and file tabs), and **Context**.
   - **Global tabs:** **Home** (the cross-session board of #1968) and **Fleet** (#1322).
   - **Pulse Inspector** stops being a tab and becomes the run detail view inside Now.
2. **Home is global and Now is per session.** Session-owned widgets (#1965) render in Now; global widgets render only in Home. This resolves the glossary's "Home is window-global" against #1965/#1966's per-session ownership without making either false.
3. **Widgets are declarative specs bound to typed records.**
   - Sessions append records (`run`, `series`, `progress`, `campaign`, `compute`, `calibration`, `measurement`) with provenance and a trust level that only the corrector sets.
   - A widget is `{view, bind, options, size}` rendered by a first-party view library inside the existing sandboxed frame.
   - The sandboxed ES module remains as `view: "custom"`, with its data still coming through bound records.
4. **One visual language.** It takes harmoniqs-ai's structure (panels with mono eyebrows, rails, dot-grid plots, blur-in reveal) on the app's live tokens (`#FFE614` with an ink edge, one 4px radius, the v2 neutrals). DM Sans is the text face and JuliaMono is the only mono, including in the terminal.

## Why

- **Duplication.** The panel had grown four tab systems, two drag-and-drop libraries, and two Home hosts that had drifted apart.
- **Widgets were stale code.** They baked data into code, so every update re-authored JavaScript and nothing could list runs.
- **Missing contracts.** The data underneath had no objective-kind, feasibility or compute contract. The mocks built from real state show leaderboards that would rank infeasible iterates first, and convergence curves that plot a draw counter as an objective. Fixing the views without fixing the records would make wrong numbers look better.

## Conditions of acceptance

- One tab system with per-session `{open, tab, width, maximized}`. The legacy strip copy is deleted.
- Files opens target a named session (#1648), and tabs persist (#1640).
- `GET /amicode/records`, its SSE stream and `GET /amicode/runs` exist. The run gate writes `run`, `series` (with `defect`) and `compute` (with measured `wall_s`).
- The view library renders RunCard, LabBoard and ProgressRail from records with no run id hard-coded anywhere in a widget.
- Every number rendered by a first-party view carries its source, and an `untrusted` chip until the corrector agrees.
- Both themes pass the design-system checks. Uppercase labels never transform physics notation.

## Accepted costs

- **Rewritten widgets.** Existing agent-authored widgets must be migrated or dropped (SPEC §E).
- **A new contract.** Records add a write path that every runner must honor. Mirrored external runs stay `untrusted` until a re-roll writes a corrector record.
- **A narrower Now.** Now shows only this session, so a researcher looking for another campaign goes to Home.

## Considered

- **Keep the tabs and clean up the code.** Rejected: it removes the duplication but leaves four ways into one file and Home's dual identity.
- **Better JavaScript widgets with a shared kit.** Rejected: it still bakes data into code and puts each honesty rule in every author's hands.
- **First-party panels only.** Rejected: sessions must be able to make views for new domains, such as calibration today and QEC tomorrow, without a release.

## Flip conditions

- If declarative specs can't express a recurring need after two domains have shipped, add the view to the library rather than widening `custom`.
- If per-session Now proves too narrow for multi-campaign directors, allow a director's Now to include its child sessions' records. Never other roots.
