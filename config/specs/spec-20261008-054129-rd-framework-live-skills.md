---
type: spec
schema_version: "1"
spec_id: spec-20261008-054129-rd-framework-live-skills
task_type: plan
parent_issue: 1731
feature_branch: opencode/issue-1731-rd-framework-record
acceptance:
  - telaio_gap_issues_filed >= 6
  - autodev_live_skill_refs == 0
  - develop_skill_dirs == 1
  - mode_bindings_autodev == 0
  - loop_todo_boundary_rule_coverage == 3
  - open_threads_stale_todo_parked == 0
invariants:
  - forward-only read-resolve — the merged develop skill names its former id inside its own text; historical records (campaign ledgers, prior specs, mode-alias tables) are never rewritten
  - mode-id aliases (autodev→develop, autoresearch→research) and their tests are untouched by the skill merge — an agent resolved as autodev still binds the develop posture
  - the human-merge gate for skills is unchanged on both harnesses (skills-integrity PRs; Telaio Fleet rung-3 SELF_MOD_CLASSES)
  - hub re-stage + restart is an ops step (hub-restart.sh), never claimed done by a merged PR
baseline: { none_because: "framework-state deliberation, not a launch; the current state recorded in Context is the baseline" }
---

# Autonomous R&D framework: live skills, one develop skill, loop todo discipline

## Context

The framework state, mapped this session (all claims source-verified):

1. **Skills are boot-frozen — the last non-live context source.** A SKILL.md edit crosses two lags
   before reaching a session: the staging copy (rsync at server restart only, additive — no
   `--delete`) and the engine's per-Location parse cache (`packages/core/src/skill.ts:107`,
   cached forever after first `list()`). Meanwhile instructions (AGENTS.md), stack state, and
   memory cards are all already read live per turn, and the mid-session delivery machinery
   (per-turn reconcile, `SessionContextEpoch`, `ContextUpdated` events) is built and tested —
   the cache is the single choke point, and the code pins an author's question there asking
   exactly for watcher invalidation.
2. **Staging admission is inconsistent.** The hub stages 104 skill dirs of which the committed
   scripts account for ~45 (35 extension + a 10-skill vault allowlist that names 5 skills which
   no longer live in the vault); ~57 dirs are residue of an ad-hoc Oct 1 full-vault sync; the
   hand-maintained hub AGENTS.md skill index provably drifts (it lists `autoresearch`, not
   `research`/`develop`). The VS Code client-side path stages ALL `surface: internal` vault
   skills with mount presence as eligibility proof — the hub is silently more restrictive than
   the client, and nothing verifies either.
3. **Telaio's skill system (landed Oct 1–2, PR #102) grew Telaio-shaped, not contract-shaped.**
   It loads its own root (`~/.amico/skills`) with no admission manifest, no surface/entitlement
   gate; the matcher's corpus is a serve-boot snapshot while the skill tool re-resolves live;
   resume rebuild disarms the #98 model-version gate. The `run_verification` env-matched
   runtime matches the amicode seam spec exactly, but has no authoring format and no consumer
   beyond tests. Gym consumes prova scenario cards but wires no skills seam.
4. **The develop mode is split across two skills with a confusing naming asymmetry.** The mode
   protocol lives in `autodev` (id deliberately retained at the #858 rename), the issue-DAG
   walk in `develop`, each cross-deferring to the other — asymmetric with `research` (one
   skill, one mode) and a recurring confusion source.
5. **The loop protocols' task state has an unmanaged shadow.** The intended state is the session
   ledger (§3 active work / §5 next queue, rewritten every loop boundary). The todowrite list is
   a second surface that persists for the whole campaign session, no mode skill mentions todo
   discipline at all, and the tool text pushes accumulation — so closed loops' pending items
   linger, and `open_threads.ts` classifies those sessions as parked resume candidates forever.
6. **The develop loop lacks error-correction machinery** that already exists unwired in the
   library: the `code-review` reviewer subagent (Julia idioms, quantum domain, test
   meaningfulness, allocations — never invoked by the loop), layer-skill loading (Claude-side
   only), no coverage measurement anywhere, `improve-codebase-architecture` unwired.

## Decisions

- **D1 — Merge `autodev` into `develop`: one skill per mode.** The merged `develop` skill is
  protocol-first (ledger, loop bound to the dev gate pack, roles, handoffs, honest degradation,
  compaction honesty) with the issue-DAG walk as the mode's primary workflow section, the two
  files' worktree/parallelism content deduplicated. The former id is named inside the skill
  (forward-only read-resolve). Mode bindings (`modes/develop/mode.toml`, the mode card, the
  primary agent card) reference `develop` + `director-core` only. The structural test
  (`workflow_skills_public.test.ts`) is rewritten for the merged shape — it currently pins the
  two-skill split and is changed WITH the merge, not after. This supersedes the three-mode
  rename record's "skill id retained" clause (spec-20260907-011500 D1 rev 3); the PR records
  the supersession honestly.
- **D2 — Telaio seam gaps become filed issues, not code.** Six issues in harmoniqs/Telaio.jl:
  admission-manifest consumption, verification-expression authoring + campaign wiring, gym
  skills-seam wiring + shared episodes, menu-corpus liveness, resume version-capture, docs. No
  Telaio code changes in this campaign slice; the local checkout is stale (main @ Sept 7,
  skills work absent) and gets synced before any future Telaio work.
- **D3 — Todo discipline is a derived view of the ledger.** `director-core` owns the canonical
  loop-boundary rule — rewrite the todo list to mirror ledger §3/§5 at every loop boundary,
  clear what closed, a stale todo list is a lying §3 — and `research` + `develop` bind it.
  `open_threads` triage stops classifying stale-todo sessions as parked: parked requires
  pending todos AND recency; an old session with pending todos surfaces as stale, not parked.
  Genuinely parked sessions must still classify parked (no regression).
- **D4 — The hot-loading workstreams are recorded, queued, and scoped out of this slice.**
  A1 (engine watcher-driven skill-cache invalidation, answering the pinned question at
  `core/src/skill.ts:107`; V1/TUI stays boot-frozen, documented), A2 (manifest-driven symlink
  staging: all `surface: internal` vault skills stage, manifest = harness-agnostic contract
  data, generated skill index replaces the hand-maintained one, residue purged), B1 (staging
  golden tests across entitlement/mount regimes), B2 (prova AmicodeDriver seam + shared
  scenario episodes). Each gets its own issue at execution time; this spec schedules them.
- **D5 — Develop-mode error-correction gates are declared protocol-level, enforced
  harness-natively.** The pack schema is the insertion point: reviewer-subagent gate (wire
  `code-review` into integrate as a mechanical pre-merge pass), layer-skill loading (the
  implementer loads the target package's `*-dev` skill first), architecture-critique pass
  (advisory findings), coverage gate authored as an env-evaluable verification expression so
  it rides Telaio's `run_verification` unchanged. Human review gates stay human.
- **D6 — The rename residue sweep rides D1's PR where files overlap.** Hub AGENTS.md index rows
  (stale `autoresearch` row removed, `research` row added, `develop` row updated to the merged
  description, `director-core` row's posture-model description refreshed); amicissimo's
  CONTEXT.md posture-name line is a separate follow-up PR (different repo).
- **D7 — Sequencing.** D1 and D3 land first (small, self-contained, unblock everything
  psychological); D2 issues publish alongside; D4/D5 workstreams execute after, each with its
  own issue + gates.

## Measurement Protocol

- `telaio_gap_issues_filed >= 6` — `gh issue list -R harmoniqs/Telaio.jl` counts the six gap
  issues (admission manifest, verification authoring, gym wiring, menu liveness, resume
  version-capture, docs).
- `autodev_live_skill_refs == 0` — repo grep for live skill references
  (`rg 'the .autodev. skill|invoke .autodev.' packages/ ops/server/hub-AGENTS.md`) returns zero;
  mode-alias tables, alias tests, and naming-history comments are excluded by pattern.
- `develop_skill_dirs == 1` — exactly one `packages/extension/skills/develop/`; no
  `skills/autodev/` directory.
- `mode_bindings_autodev == 0` — `modes/develop/mode.toml`, `modes/develop/card.md`, and
  `agents/develop.md` contain no `autodev` skill binding.
- `loop_todo_boundary_rule_coverage == 3` — grep for the loop-boundary todo-rewrite rule
  matches in `director-core`, `research`, and `develop` skills.
- `open_threads_stale_todo_parked == 0` — a test asserting a session with pending todos whose
  last activity predates the recency window is NOT classified parked; paired regression test:
  recent activity + pending todos still parked.

## Plan (compiled by hand — tooling=manual; plans are not hand-editable once compiled, so this
record is the authority and each step's issue carries its own gates)

| # | Step | task_type | Gates | Status |
|---|------|-----------|-------|--------|
| 1 | Publish the framework PRD + rename + todo-discipline issues (amicode) and the six Telaio gap issues | bookkeeping | user approval of rendered drafts | this session |
| 2 | Commit this spec under the PRD (docs-only PR) | bookkeeping | review section recorded | queued |
| 3 | D1 merge PR: merged skill, reference sweep, structural test rewrite, hub index rows | implement-slice | workflow_skills_public green · mode-card parity · lint-skills · grep criteria | queued |
| 4 | D3 todo-discipline PR: skill-text rule in 3 skills + open_threads triage fix + tests | implement-slice | skill lint · both triage tests green | queued |
| 5 | A1 engine PR (opencode fork): watcher-driven SkillV2 cache invalidation + skill-tool content re-read | implement-slice | cache invalidation tests · epoch reconcile integration test | queued |
| 6 | A2 staging PR (amicode): manifest-driven symlink staging + generated skill index + residue purge | implement-slice | staging admission assertions · index generated · purge verified | queued |
| 7 | B1 staging goldens PR | implement-slice | four-regime golden set green | queued |
| 8 | D5 gates: E1 reviewer wiring + E2 layer-skill loading PR; E3 + E4 follow | implement-slice | pack gates schema'd · reviewer dispatch test | queued |
| 9 | B2 prova AmicodeDriver + shared episodes | implement-slice | scenario episodes green both harnesses | queued |
| 10 | amicissimo CONTEXT.md posture-name line + role-card autoresearch sweep PR | implement-slice | grep clean | queued |

Steps 5–9 each get their own issue with a full standard-tier body at execution; this spec's D4/D5
paragraphs are their design-of-record. Launch-shaped: none (bookkeeping + implement-slices).

## Non-goals

- Executing the A1/A2/B/E workstreams in this slice (steps 5–9: recorded, queued, each with its
  own issue + gates when executed).
- Any Telaio code change (D2 files issues only; the local checkout sync is an ops chore).
- The `autoresearch` staging ghost dir and the 57-dir residue purge (A2's manifest work owns it).
- V1/TUI hot-reload parity (A1 documents hub-first honestly).
- Rewriting historical records (ledgers, prior specs, the alias tables) — forward-only.

## Review (by hand — tooling=manual, `amico spec review` absent; a weaker claim than tool-run,
perspective-isolated critics, recorded as such)

Three lenses applied manually. No blocking contradiction found (no two spec lines that cannot
both be true). All findings advisory; each resolved into the spec or carried as an obligation.

- **Lens A — vocabulary (the "reads a field its schema doesn't carry" defect class).** The
  sweep must distinguish `autodev` as a SKILL id (swept, D1) from `autodev` as a MODE id
  (alias vocabulary — `MODE_ID_ALIASES`, its tests, the posture machinery — untouched).
  Resolved: the grep criterion is patterned to skill references
  ("the `autodev` skill" / "invoke `autodev`"), and D1 names the alias tables as invariant.
  Found and folded: `naming_records.test.ts:157` lists autodev as "id retained at the #858
  rename" — that inventory row flips to "merged into develop" in the D1 PR; the test file is
  part of the D1 acceptance surface.
- **Lens B — blast radius.** (B1) The skills rsync is additive, so the staged `autodev` dir
  survives the merge as a ghost — resolved: hub re-stage + ghost removal recorded as an ops
  step with the invariant that no PR claims it done. (B2) The hand-maintained hub index
  carries drift beyond the rename (stale `autoresearch` row, missing `research` row) —
  resolved: D6 folds all four index rows into the D1 PR; full index generation stays A2.
  (B3) The merged file is large (~300 lines) — accepted deliberately; the split's cost
  (cross-deferral, drifted references) exceeded the size cost, and `research` is the
  structural precedent.
- **Lens C — anti-gaming / regression.** (C1) The todo rule must be a REWRITE rule with a
  mirror target (ledger §3/§5), not an advisory nudge, or it is untestable — resolved in D3's
  wording. (C2) The open-threads fix must not mask genuinely parked sessions — resolved: the
  criterion pairs the stale-todo test with a still-parked regression test. (C3) The D1 merge
  reverses a pinned, documented decision — resolved: supersession recorded in the PR and
  here; the structural test changes in the same commit as the merge so the pin never lies.

Verdict: **approved-mechanical (by hand)** — tier 1 clean, three lenses applied manually, all
advisories resolved or tracked as obligations. Not equivalent to tool-run `approved`. Round 2.
