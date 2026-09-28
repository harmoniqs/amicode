# Paper Mode: live-draft source of truth and snapshot-base 3-way merge for AI/human co-editing

Status: proposed (2026-09-28)

Tracking: harmoniqs/amicode#1620 · Glossary: `CONTEXT.md` (Paper Mode, Draft, Pending Hunk)

Paper Mode is a new opt-in session surface for *committed* LaTeX writing (editor primary, Chat docked beneath, PDF right; distinct from Preview, which stays a viewer, and independent of the paused wide-mode work). It exists because Amicode has no safe surface for AI and human to co-edit the same `.tex`: today the agent reads a stale disk/cache snapshot (edits it "saw" go missing from its output), agent writes bypass the editor buffer (the human must reopen the file), concurrent edits clobber silently, and there is no way to review an agent change before it lands or to control when compilation runs.

The decision is fourfold, and each part is hard to reverse because tooling, UI, and the mutation boundary all bind to it:

1. **The live editor Draft is the single source of truth**, versioned by a monotonic Content Revision (extending the content-revision rule ADR-0013 already mandates). In Paper Mode the agent's Read/Edit tools read the Draft *at its current revision every turn* — never disk, never a cache. "The agent always sees my edits" becomes true by construction and checkable, because the revision it read is stamped. This supersedes the coarse revert-based fix in #1422, which only reverts a *clean* buffer and blocks while the human is typing — insufficient for real co-editing.

2. **Agent edits propose to a review layer; they do not write disk.** An agent Edit/Write in Paper Mode produces Pending Hunks — inline diff decorations in the editor — leaving the Draft and disk unchanged until the human accepts. The human's own typing writes the Draft as normal and is always authoritative. Un-accepted agent text is therefore never in the file, which is what makes "the AI never interferes," "human always wins," and "nothing compiles behind my back" all fall out of one mechanism.

3. **Concurrent edits reconcile via a snapshot-base 3-way merge.** The Content Revision the agent read at edit-start is captured as the merge base. At apply time we 3-way merge (base → human-edited Draft, base → agent hunks): non-overlapping regions land as Pending Hunks; regions both parties touched become **Conflict Hunks** the human must resolve. Conflicts are **never auto-resolved** — the human explicitly wanted to be able to check whether their text was removed. CM6's `@codemirror/merge` (already a dependency, already used in `editable-diff-view.tsx`) supplies the merge/decoration primitive.

4. **Compilation is manual, on the accepted Draft.** It fires only on an explicit Compile action and compiles the Draft as it stands — Pending (un-accepted) Hunks are excluded because they are not yet in the file. Accepted hunks emit ADR-0017 mutation-ledger receipts (appearing in Files Changed with real provenance); pending and rejected hunks emit nothing.

## Considered options

- **Agent-writes-disk with a revert-style overlay (today's #1422 model), rejected.** Reachable from current code, but the agent's text *is* in the file before the human approves, so "human always wins," "review before it lands," and "compile only on approve" all become muddy special cases rather than consequences of the model. The dirty-buffer guard also silently blocks agent edits whenever the human is typing, which is the opposite of collaboration.
- **CRDT live merge (Yjs), rejected for now.** A shared mergeable document gives Google-Docs-style seamlessness, but it is a heavy, hard-to-reverse architectural commitment, and per-hunk human review sits *on top* of it anyway. The snapshot-base 3-way merge delivers the reviewed-collaboration requirement with far less machinery; revisit only if real-time multi-human co-presence becomes a requirement.
- **Promote Preview into a primary editor, rejected.** Reverses ADR-0013 and the glossary's deliberate "Preview = viewer" boundary and tangles viewer and editor responsibilities in one component. Paper Mode is a separate bounded surface instead.

## Consequences

The agent's Edit/Write tools gain a Paper-Mode-specific behavior (propose to the review layer instead of writing disk), which must fail closed — an agent edit that cannot be expressed as a Pending Hunk is surfaced, not silently written. The Draft/revision authority and the review/merge UI are new machinery, but both build on primitives that already exist (ADR-0013 content revisions, ADR-0017 receipts, `@codemirror/merge`). Paper Mode deliberately does **not** depend on the paused wide-mode work (#1434) and is built as its own layout. LaTeX language intelligence (#1513), SyncTeX (#1432/#1514), an outline navigator, and in-editor search (#1430) are out of scope — they dock into Paper Mode later as independent slices. Revisit this decision only if Amicode adopts real-time multi-human collaboration, at which point option 2 (CRDT) is the successor.
