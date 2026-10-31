# Side panel v2: the Work Column from the ground up

Status: draft for review (2026-10-31) · Mocks: [`index.html`](index.html) · Decision record: [ADR 0038](../../adr/0038-work-column-v2-now-files-context.md)

## Summary

Each session's Work Column becomes three areas: **Now**, **Files** and **Context**. Two global tabs, **Home** and **Fleet**, sit beside them.

- **Now** shows what the session is doing.
- **Files** shows what it touched.
- **Context** shows what it knows.

Widgets stop being agent-authored JavaScript with data baked in. Sessions **write typed records** (run, series, progress, campaign, compute, calibration, measurement), and widgets become **declarative specs** that bind those records to a library of first-party views we design and maintain. Arbitrary JavaScript stays only as an escape hatch.

The visual language takes its *structure* from harmoniqs-ai and keeps the app's live tokens:

- mono uppercase eyebrows;
- hairline panels;
- status rails;
- dot-grid plots;
- the blur-in reveal.

Every number shows where it came from, and every number that could mislead is flagged. Every number in the mocks comes from real on-disk state.

## What exists today, and why it gets rebuilt

Findings from the audit (paths are in the amicode overlay unless noted):

- **The panel stacks four tab systems.**
  - **What's there:** the main strip (in two complete copies, legacy solid-dnd and v2 dnd-kit), a separate file-tree column, Preview's nested sub-tabs and panes, and file tabs.
  - **Effect:** four ways into "a file this session touched", and one 1,392-line `session-side-panel.tsx`.
- **Home in the panel is a weaker second host than `home.tsx`.**
  - `prompt` and `open` are no-ops, widgets are fetched only once, and nothing refetches.
  - Every save remounts every iframe.
- **Widgets bake their data into the code.**
  - Most of the 10 on-disk widgets hard-code run ids or inline arrays. "Update in place" means re-authoring the whole module.
  - There is no route that lists runs. The only side channel is the 24-line `run.log` tail.
  - 7 of 11 `dashboard.json` entries point at widgets that no longer exist.
  - `fleet-status` and `qldpc-challenge` can never fetch their data, because the frame CSP blocks their raw `fetch`.
- **Sizes disagree.**
  - Manifest `height`, the fixed 2×2 hero cell and the 64px dock strip all claim different sizes. Tall boards clip.
  - Every widget hard-codes a 10px radius against the 4px token.
- **Records lie by omission.** Each of these is drawn honestly in the mocks:
  - **Objective overload.** `AMICODE_ITER f=` mixes three meanings: real infidelities (rfree, r8), raw penalty objectives around 1e3 (the knot and alt Modal runs), and a placeholder `f=1e-9` with the draw counter in `iter` (the qmotion freeze run). A convergence widget cannot tell them apart.
  - **Infeasible "best" results.** The lowest objectives in `bosonic-gkp-qubit` all belong to infeasible iterates: dms-D0g 1.9e-5 with a dynamics defect of 0.81, and dmsb-E2 1.6e-5 with a defect of 0.24. The best *feasible* run is r8-S2 at 5.1e-3. A leaderboard without a defect column ranks garbage first.
  - **Unphysical fidelity.** F_ms > 1 shows up in 11 of 26 outers of dmsb-E1-cont, the run that died with rc 143. It is only possible while the constraints are violated.
- **Compute is not recorded.**
  - 0 of 50 mirrored runs write `wall_seconds`.
  - Cloud dollars exist only as one hand-written `[cost]` tail line.
  - LLM dollars live in `session.cost`, which is a list-price estimate.
  - CPU-hours and GPU-hours are not recorded anywhere.
- **Calibration and measurement have no store the UI can read.**
  - There is no strumento `FileConfigStore` on disk.
  - Task records exist only as fixtures in `amico-run/fixtures/bridge/`.
  - QILC results are ad-hoc CSV and TOML files under `~/.amico/problems/qilc-*` (well-provenanced comment headers, but no schema).
- **The ledger is free text.** Verdict classes have to be guessed by regex. The mocks do this and say so, and they get some wrong: is `GATE-HARMFUL` a refutation or a confirmation?
- **Design-system drift.**
  - **Stale skill.** The `amicode-design-system` skill still says `#fff676` and a 2/4/8/12/16 radius scale.
  - **Live tokens.** The app has already moved to `#FFE614` with an ink edge and one 4px radius (`design-polish.css`, `themes/harmoniqs.json`).
  - **Other conflicts.** `display-conventions` says 10px.
  - **Not in the repo.** PR #312's DESIGN.md never landed.
- **Fonts.** DM Sans never rendered wherever `--font-family-sans` is used (markdown, review, comments), because the settings effect wrote a system-only stack onto `:root`. The terminal defaulted to JetBrainsMono. Both are fixed on branch `juliamono-default`: JuliaMono is now the house mono, terminal included, with the Nerd Font kept as a glyph fallback.

## A. Information architecture

```
┌ Work Column ─────────────────────────────────────────────┐
│ [ Now ② | Files ⑫ | Context ]          [ Home | Fleet ] ⤢│   session tabs · global tabs · maximize
│ <session title>  <state chip>                            │
│ ...                                                      │
```

The strip is one tab system with one drag-and-drop library. The session tabs are fixed in order and are not closeable, so the drag-and-drop machinery that exists today only to reorder tabs goes away. Badges count things that want attention (Now) or changes (Files). Panel state (`open`, `tab`, `width`, `maximized`) is per session (#1966).

### Now (session)

Sections, ordered by urgency:

1. **Needs you.** Pending questions and permissions for this session and its casts, failed gates, failed runs, and watcher flags. Each row has one action. The strip is empty when nothing is pending, and then it takes no space.
2. **Live runs.** One RunCard per run this session launched or mirrored. A run family (the same spec with different seeds or arms) collapses into one card with overlaid traces. It docks as a 64px strip when scrolled away.
3. **Campaign.** Present when the session is a research director. Shows the ledger's verdict distribution, the latest verdicts, and a link to the maximized board.
4. **Casts.** The rail of subagent sessions, with role, duration and cost.
5. **Compute.** This campaign's LLM dollars by role, agent time, and cloud spend.
6. **Watcher.** Off by default. Start, pause and steer controls, plus the last verdict block (see *Watcher* below).
7. **Widgets from this session.** Session-owned widgets in authoring order, each with its revision history (#1965).

The Pulse Inspector folds in as the RunCard's detail view: click a run and Now shows its pulse, convergence and log. It is no longer a separate tab with "Soon" stages.

### Files (session)

One workspace replaces the Files Changed tab, the file-tree column, Preview and the file tabs.

- **Tree** with a filter: *Changed* (written by this session, which is the default and carries the badge) or *All*. The workspace roots are this session's directories plus any problem workspace it touched.
- **Panes:** editor and preview panes in the ADR 0013 split model. Tabs persist per session (#1640/#1641), and opening a file targets the named session only (#1648).
- **Data preview:** CSV, TOML and JSONL open as typed tables. **Chart as widget** turns a preview into a widget spec bound to that file. This is the bridge between "a file the agent wrote" and "a view I keep".
- **Maximize:** the Work Column can take any width (#1434/#1548). Files is the main beneficiary.

### Context (session)

- Context-window usage.
- The session's System Context blocks, rendered for humans: the ADR 0035 named outcomes.
- Vault priors cited this session.
- The campaign ledger's raw text.

### Home and Fleet (global)

- **Home** is the cross-session board described in #1968:
  - **Needs you:** failed gates and runs, pending questions, handoffs.
  - **Campaign cards:** one per active campaign.
  - **Overnight results** and a **compute total**.

  It is the only place global widgets live. When maximized it is a full-width board (see `home.html` and `compute.html`).
- **Fleet** is Fleet Manager (#1322).

## B. Widgets v2

### Records (what sessions write)

A record is one line of JSON with a common envelope:

```json
{ "kind": "series", "id": "r20261031-012505Z-rfree-R6", "session": "ses_…", "message": "msg_…",
  "at": "2026-10-31T01:41:00Z", "provenance": { "source": "run.log", "path": "~/.amico/runs/…", "sha256": "…" },
  "trust": { "level": "untrusted", "by": null }, "data": { … } }
```

| kind | `data` (essentials) | first producer |
|---|---|---|
| `run` | lab, executor, host, status, rc, `objective: {name, kind: infidelity\|penalty\|other, sense}`, spec/formulation hashes | `amico run` gate, `mirror_run.py` |
| `series` | appended points `{i, objective, defect, …extras}`; the `defect` (constraint violation) rides with every point | run gate parser (replaces `AMICODE_ITER` scraping) |
| `progress` | `{step, of, label, metrics}`, for runs whose progress is not an objective (draws, sweeps) | qmotion freeze runner, strumento tasks |
| `campaign` | ledger path, `hypotheses: [{id, label, verdict_class}]`, active casts, loop index | director at every loop boundary |
| `compute` | executor, host, cores, `wall_s` (measured), `billed_usd`, `llm_usd`, launching cast and hypothesis | run gate on exit; session cost rollup |
| `calibration` | device, `config_content_id`, `params: {name: {value, unit, prev}}`, gate results | strumento `calibration` event |
| `measurement` | a typed table: `{columns: [{name, unit, sense}], rows, comparisons: [{name, mean, lo, hi, n, reading}]}` | QILC/QP-ILC scorers |

Rules:

- **Append-only.** A correction is a new record that names what it supersedes.
- **Readers skip unknown kinds and fields, and never fail on them.** strumento's `progress.jsonl` already follows this rule.
- **The trust level is set only by the corrector**, meaning a re-roll or a pinned validator. Widgets render `untrusted` until then.
- **Storage:** records live beside the artifact they describe, in `runs/<lab>/<run>/records.jsonl` or the problem workspace. A session index under `~/.amico/records/` keeps listing cheap.

### Routes

- `GET /amicode/records?kind=&session=&lab=&since=` returns paged records.
- `GET /amicode/records/stream` is an SSE stream of the same, used for live views. This replaces per-widget `setInterval`.
- `GET /amicode/runs?lab=&session=` is the run listing that doesn't exist today.

Everything is read-only and allow-listed through the existing bridge. These routes replace the idea of bringing back `run-status` and `problems` as untyped JSON.

### Widget specs (what the agent authors)

```json
{ "id": "gkp-rfree-family", "title": "Solve family · rfree R1–R6", "scope": "session",
  "view": "RunFamily",
  "bind": { "kind": "series", "where": { "lab": "bosonic-gkp-qubit", "id~": "rfree-R\\d$" } },
  "options": { "best": "min(objective) where defect <= 1e-6", "x": "i", "y": "objective" },
  "size": "card" }
```

- **Authoring:** `amicode_author_widget` takes a spec. Specs are validated against the view's schema and stored per session.
- **Revisions:** each update adds a revision with the producing message id, so a session's widgets accumulate instead of overwriting (#1965).
- **Failure:** a widget that cannot render shows a named reason (ADR 0035's named-outcome rule) with **Retry**, **Show error** and **Ask the agent to fix**.
- **Escape hatch:** `view: "custom"` keeps today's sandboxed ES module for things the library can't express. Its data still comes through bound records.
- **Sizes:** four, and the grid honors them.

  | size | form |
  |---|---|
  | `strip` | 64px, docked form |
  | `tile` | half width |
  | `card` | full panel width, height from content |
  | `board` | maximized or Home only |

### The view library (first party)

`views.js` in the mocks is the prototype. The views and their honesty duties:

| view | shows | must also show |
|---|---|---|
| Panel, Rows, Stats, Chip, Rail | structure | source path in the header; `untrusted`/`verified` chip |
| RunCard / RunFamily | convergence on a dot-grid log axis | objective kind; ≤ 0 values as hollow floor marks, never clipped silently; defect trace |
| LabBoard | ranked runs | feasibility column; runs whose objective is not comparable are hidden *and counted* |
| ProgressRail | phases and gates | failing gates in danger color with their value |
| CampaignBoard | verdict distribution and table | the director's words next to the parsed class |
| ComputeLedger | LLM, cloud and wall time by campaign, role and executor | measured vs. inferred, list price vs. invoice |
| CalibrationCard | device parameters, pulses, task rail, gate meter | synthetic or fixture badge; model curves watermarked MODEL |
| DesignStrip / Forest | measurement designs on a log strip; paired effects with CIs | reference line; filled only when the interval excludes 0; n pairs |
| Gantt | casts and runs over time | inferred spans labelled |

### Watcher

This folds in the earlier plan. **Start watcher** on Now creates a root session linked by `metadata.watches`. The server wakes it when any of these happens, debounced to about 2 minutes:

- the main session goes idle;
- a cast finishes;
- the ledger file changes;
- a `run` or `series` record arrives.

Each wake ends with a verdict block (`OK | WATCH | STEER`, findings, and an optional steer). Findings must come from records, as in the campaign mock, never from invented facts.

- **Steering:** off by default. When on, it goes through `amicode_steer` with these guards:
  - at most one steer per wake;
  - a cooldown of 15 minutes or more;
  - wakes caused by the watcher's own steers are ignored;
  - every steer is mirrored into Now.

## C. Data that must exist first (the real work)

1. **Compute records from the run gate.** `wall_s` measured at exit, plus executor, host and cores. Modal runs read the cost back from the Modal billing report. LLM cost is rolled up from `session.cost` and labelled as a list-price estimate.
2. **The objective and defect contract.** Each `run` record declares `objective.kind`. `series` points carry `defect`. `AMICODE_ITER` stays as a compatibility input but is parsed into `series` or `progress` by kind.
3. **Structured verdicts.** The director writes `verdict_class` (confirmed / refuted / partial / stopped / open) into the `campaign` record at each loop boundary. The ledger markdown stays the human record.
4. **strumento task records → `calibration` and `progress` records.** The ledger-bridge already reads task dirs (`docs/ledger-bridge-contract.md`).
5. **A `measurement` record emitter for scorers.** The QILC CSVs already carry the provenance header (spec, intonatissimo sha, manifest sha). The emitter adds units and sense per column.
6. **Cleanup.**
   - Filter the e2e and test pollution: 873 of the ~897 run dirs in `runs/default` point at temp or test scripts.
   - Drop the stale `dashboard.json` entries.

## D. Visual language

Structure from harmoniqs-ai (`app/components/demo/parts.jsx`, `scenes.jsx`, `PulseChart.jsx`, `CalibrationCircuit.jsx`), tokens from the app.

- **Faces.** DM Sans carries all text, and JuliaMono carries data, code, labels and the terminal. Both are already bundled. `font-synthesis: none` on mono, so it never fakes a bold.
- **Color.**
  - **Neutrals:** the v2 ramp. Light is `#fff` / `#fafafa` / `#f5f5f5` with ink text. Dark is `#161616` / `#1d1d1d` / `#242424` with `#f2f2f2` text.
  - **Accent:** one, `#FFE614`. It is always a fill, and always takes an ink edge by day.
  - **Where yellow appears:** one CTA per view, the selected-row fill, the director series in compute charts, the Verified chip, and the plot primary trace *at night only* (ink by day, as on the site).
  - **State colors:** used only as success, warning or danger semantics, each paired with a word, never alone.
- **Geometry.** One 4px radius, a 4px spacing grid, 1px hairlines, no shadows.
- **Type roles.**
  - **Eyebrow:** 10px mono, uppercase, +0.12em tracking.
  - **Stat:** 18px mono, tabular.
  - **Body:** 13px DM Sans.
  - **Board titles:** 28px/700 at −0.03em.
- **Notation beats case.** Uppercase eyebrows must not uppercase physics: `b ≠ B`, `µs` must not become `MS`, `π` must not become `Π`. Symbols wrap in `.nocase`. The mocks caught all three.
- **Numbers.**
  - **Notation:** researcher notation (`5.3e-3`, `1−F_ms`), tabular figures, true minus signs.
  - **Units:** never inside an uppercased label.
  - **Labelling:** every inferred quantity says *inferred*, and every estimate says *est.*
- **Plots.**
  - **Ground and axes:** a dot-grid (0.6px dots every 16px at 13% ink), axes at 13% ink.
  - **Traces:** 1.6px primary, with secondaries at 45%.
  - **Readability:** log axes switch to 1-2-5 or linear ticks when the range is narrow.
  - **Honesty:** model curves are watermarked, and unphysical values are drawn on the floor as hollow marks.
- **Motion.**
  - **Reveal:** blur-in (8px, 8px rise, 0.4s).
  - **Live state:** a pulsing ring on running nodes, and a slow dash march on live traces.
  - **Reduced motion:** collapses all of it.

**Follow-ups this implies:**

- **`amicode-design-system`:** fix the yellow hue and the radius scale, and add the notation rule.
- **`display-conventions`:** change 10px to 4px, and add the objective-kind and feasibility duties.
- **DESIGN.md:** port PR #312's file, amended to these values, into `design-polish.css`'s home.

Each lands through skills-integrity as a human-merged PR.

## E. Migration

| widget on disk | fate |
|---|---|
| `live-solve`, `x-gate-live-solve`, `gkp-prestissimo-solves` | → RunFamily / LabBoard specs bound to `series` |
| `r0b-r9-modal-tracker` | → ProgressRail + ComputeLedger once the qmotion runner emits `progress` and `compute` |
| `pasqal-cz-pulse-board`, `hrl-cz-20ns-pulse` | → PulsePlot spec bound to the pulse artifact |
| `qilc-measurement-board`, `qpilc-campaign-board` | → CampaignBoard + Forest bound to `campaign` and `measurement` |
| `qldpc-challenge`, `fleet-status` | drop (unreachable data); Fleet covers the second |
| `jump-back-in` (builtin) | → Home's needs-you / recent rows |

The `amicode_author_widget` tool description and the `live-solve` skill are rewritten around specs. The tool description still lists `run-status` and `problems`, which the overlay removed.

## F. Slices (to become sub-issues after review)

1. **Records core:** the envelope, append-only store, `/amicode/records`, the SSE stream and `/amicode/runs`. The run gate writes `run`, `series` and `compute`.
2. **View library v0:** Panel, Rows, Stats, Chip, Rail, RunCard and LabBoard inside the widget frame runtime. Spec validation, sizes, named failure states.
3. **Work Column shell:** one tab system with Now, Files, Context, Home and Fleet; per-session panel state. Delete the legacy strip copy.
4. **Now v0:** needs-you, live runs and casts. Pulse Inspector folds in as run detail.
5. **Files workspace:** unified tree with filters, panes and persisted tabs, session-targeted opens, data preview, and "Chart as widget".
6. **Campaign, compute and the watcher:** `campaign` records with `verdict_class`, CampaignBoard, ComputeLedger, and the watcher session with steering guards.
7. **Calibration and measurement:** strumento bridge to `calibration`/`progress`, the scorer `measurement` emitter, CalibrationCard, DesignStrip and Forest.
8. **Home board:** global needs-you, campaign cards, overnight results, compute. Migrate or drop the existing widgets and clean up `dashboard.json`.
9. **Design-system follow-ups:** skill fixes, the DESIGN.md port, the notation rule in lint (uppercase transforms on known symbol glyphs).

## Open questions

- **Record ownership across the fleet.** Should records sync with the session (hub-owned), or stay host-local with the index federated? The runs already live on `erlich` while the client is a laptop.
- **Ledger authority.** Should the director write `campaign` records directly, or should a librarian pass derive them from the ledger diff? Direct writes are cheaper; derived records can't drift from the human record.
- **Spec expressiveness.** Do `where` and `options` stay as a tiny declarative language, or bind to named server-side queries (`query: "best-feasible", args: {…}`)? Named queries are easier to test and keep the honesty rules on the server.
- **Global widgets beyond Home.** Is there any case for a global widget showing inside a session's Now? The proposal says no: Now is strictly this session.
