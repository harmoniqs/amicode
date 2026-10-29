---
name: research
description: The research mode's director loop protocol — session-ledger discipline, the hypothesizer/experimenter/analyzer trio, deliberate spec gates, checkout registry, and compaction-any-time safety. Use when starting, running, or resuming a research loop. (The mode and this skill renamed from `autoresearch` per the three-mode surface; old ids read-resolve to `research`.)
agents: [hypothesizer, experimenter, analyzer]
surface: public
project_contract:
  folders: [ledger/hypotheses, ledger/observations, ledger/campaigns, scripts, data, reports, config]
---

# Research — the director's protocol

> **Install conventions** — this skill operates on a **Research Project** (detected by
> `research-project.toml` in the workspace). All load-bearing state — campaign ledgers,
> hypotheses, observations, specs, scripts, data, and reports — lives in the project
> directory. The protocol is engine- and install-neutral; bindings for a given engine stay
> engine-side (the opencode binding of the director role is the `research` primary
> agent card).

**Entry points:** the `research` primary agent (Tab-switch into research mode —
its prompt embeds this spine), direct invocation of this skill, or the standing line in
the user's research kickoff prompts. All three lead here; this file is the protocol.

The operating principle: **the context window is a cache; the project is the database.**
Every piece of load-bearing state lives in project files — campaign ledgers, hypotheses,
observations, scripts. The context window holds only the working set. Compaction (manual
or auto) then costs nothing but a cache refill.

## Project paths

All artifacts live inside the Research Project directory. The `## Active Research Project`
block in the system prompt (injected by `stack_state.ts` when a workspace folder has
`research-project.toml`) confirms the project root.

| Artifact | Path |
|----------|------|
| Campaign ledger | `<project>/ledger/campaigns/campaign-<YYYYMMDD>-<slug>.md` |
| Hypotheses | `<project>/ledger/hypotheses/` |
| Observations | `<project>/ledger/observations/` |
| Spec cards | `<project>/config/specs/` |
| Experiment scripts | `<project>/scripts/experiment/` — optimization solves, gate synthesis |
| Analysis scripts | `<project>/scripts/analysis/` — post-processing, plotting, comparison |
| Testbed | `<project>/scripts/testbed/` — simulated gym environments, hardware interfaces |
| Data | `<project>/data/` |
| Config | `<project>/config/` |
| Reports | `<project>/reports/` |
| Checkout registry | `<project>/ledger/campaigns/CHECKOUTS.md` |
| Environment proposals | `<project>/ledger/environment-proposals/` (created on demand) |
| Environment digest | `<project>/ledger/campaigns/env-digest-<campaign-slug>.md` |

## Research Environment integration (#890)

When the project is bound to a Research Environment (the `## Active Research
Environment` block appears in the system prompt), the environment provides
shared knowledge, code, and configuration across sibling projects.

### Environment digest assembly

At campaign **kickoff**, assemble an environment digest:

1. Read the environment manifest (`research-environment.toml`) — note `[domain]` fields
   and the `[paths]` section (directory names may be overridden).
2. Scan environment directories — `insights/`, `methods/`, `context/`, `literature/`,
   `results/`, `templates/`, `config/`, `lib/`, `experiments/` — using names from `[paths]`
   when overridden.
3. Filter by relevance: match the manifest `[domain]` + project `tags` + campaign objective.
   This filtering is judgment-based, not programmatic.
4. Write the digest to `<project>/ledger/campaigns/env-digest-<campaign-slug>.md`.
5. Include: relevant insights, methods, sibling project summaries, results candidates,
   context notes. Add an excluded appendix listing what was omitted and why.
6. If the campaign ledger §1 contains a `digest_include` list, force those notes into the
   digest regardless of filtering.

**Update the digest at each loop boundary** — new environment content may have arrived.

### Subagent briefs with environment paths

When briefing subagents and the project is bound to an environment, include these fields:

| Role | Fields in brief |
|------|----------------|
| **Hypothesizer** | `env_digest_path` — read the digest for cross-project context and provenance |
| **Experimenter** | `env_digest_path`, `env_lib_path`, `env_lib_importable` (false until deferred), `env_templates_path`, `env_config_path`, `env_context_path` |
| **Analyzer** | `env_digest_path` — read the digest; may propose environment insight proposals |

All paths respect `[paths]` overrides from the environment manifest.

When the project has **no environment binding**, omit these fields entirely (do not pass
empty strings or null values).

### Per-iteration staging

At each loop boundary (after the analyzer returns):

1. **Stage project card update** — if the project's `research-project.toml` status changed
   or best results improved, update the card.
2. **Stage insight proposals** — the analyzer may produce structured insight proposals
   (YAML frontmatter with `type: insight`, `visibility: environment`). Write them to
   `<project>/ledger/environment-proposals/`. They are candidates for `amico env promote`.

### Promotion suggestion

At campaign boundaries (when the campaign objective is met or the loop closes), suggest
running `amico env promote` on any staged proposals in `ledger/environment-proposals/`.

## The campaign ledger (create at kickoff, before any work)

Path: `<project>/ledger/campaigns/campaign-<YYYYMMDD>-<slug>.md` — this project-local ledger serves Research-Project-scoped work and reconciles to the **session ledger** in the personal vault (`sessions/session-<YYYYMMDD>-<slug>.md`, per `director-core`'s discovery rule) at each loop boundary. Nine sections, in order:

1. Objective & standing directives
2. Hypothesis ledger (H# → verdict → evidence → wiki-links)
3. Active work — every in-flight item, INCLUDING uncommitted per-file diff state AND every
   in-flight subagent cast (role, session id, spec id, assigned env, expected artifacts)
4. Blocked & reasons
5. Next queue
6. Checkout topology (mirror of this session's rows in `ledger/campaigns/CHECKOUTS.md`)
7. Gotchas & methodology
8. Loop log (append-only, one row per loop: date, H#, spec_id, review verdict, plan hash,
   experimenter session id, gate verdicts, advisory closures)
9. Compaction log (append-only: timestamp, auto/manual, messages dropped, summary audit)

**Update triggers — all of them:** kickoff; every loop boundary; **immediately BEFORE
casting any experimenter** (record the cast — a compaction mid-flight must be able to learn
from the ledger what is in the air and where its artifacts will land); immediately before
any manual `/compact`; at pause/handoff.

**First action after ANY compaction: re-read the ledger from disk, then audit the summary
against it** — does the summary name the ledger path, carry the current H-verdict table,
reference the in-flight casts? Append the audit row to §9.

## The loop (one iteration)

1. **Re-read the ledger** — from disk, never from memory.
2. **Hypothesis queue thin?** Cast the **hypothesizer** (read-only subagent): ranked
   hypotheses + a spec-card draft. Parent picks the winner. The hypothesizer reads
   the findings ledger (`amicode/skills-integrity/`, personal vault) as a prior —
   known-bad recipes don't become proposed approaches.
3. **Spec gate (deliberate):** file the spec card to `<project>/config/specs/`, run
   `amico spec review <path>` — resolve blocking findings, re-run (round budget 3).
   `--allow-unreviewed` is FORBIDDEN for launch-shaped work (spends compute); if compile
   refuses for want of review, the fix is to review, never the flag.
4. **Ledger the cast, THEN cast the experimenter** (one experiment per spec, assigned env
   per `ledger/campaigns/CHECKOUTS.md`; claim the checkout row first). Parallel experimenters only
   where the registry says files are disjoint.
5. **Run the gates yourself (parent, via bash):** test suites, `amico plan status` where a
   compiled plan exists. Verdicts are DERIVED, never self-reported. No LLM — including
   you — judges a fidelity claim; LLM judgment is confined to drafting criteria and
   interpreting results, adversarially reviewed, human-owned at promotion.
6. **Cast the analyzer** (read-only): raw-artifact-grounded insights, a proposed ledger
   delta, next-hypothesis seeds. The analyzer's duties include the skill-friction
   check: scan raw artifacts for instructions-vs-reality mismatches (→ finding) and
   repeated un-skilled idioms (→ `proposal`-type finding, a new-skill candidate,
   provenance-tagged with sessions/artifacts).
7. **Commit the ledger update** (sole writer): H-table row, loop-log row, §3 state, next
   queue. Close every advisory (fixed / waived-with-reason / obsolete) and record closures.
   The update also carries the campaign's **skill delta** row — findings filed, skills
   touched, proposals pending — so the loop's own improvement is part of its record.
   Rewrite the session todo list to mirror §3 and §5 — the derived-view rule in
   `director-core`: current loop only; a stale todo list is a lying §3.
8. **Repeat.** Compact only at a boundary, and only when the user is present to choose it —
   the protocol does not otherwise try to time compaction (see below).

## Roles at a glance

| Role | Subagent | Briefed with | Returns | Never |
|---|---|---|---|---|
| hypothesizer | read-only (edit+bash denied) | objective, ledger path | ranked hypotheses + spec card | executes anything |
| experimenter | full access, one spec | reviewed spec, env assignment, note path | numbers-only debrief + own experiment note | touches ledger; grades itself |
| analyzer | read-only (edit+bash denied) | note + RAW artifact paths, gate verdicts | ledger-delta proposal + next seeds | writes; decides |

Enforcement honesty: the two read-only roles are permission-isolated; the experimenter's
ledger-abstinence is discipline + git history. The parent is the SOLE ledger writer.

## Deliberate integration — current tooling state (honest)

- `amico spec review` WORKS on this box: tier-1 mechanical lenses always; judgment critics
  when a critic binary is available — when the verdict is `approved-mechanical`, say so,
  and weigh a manual critic round (independent read-only subagents, one lens each:
  consistency / ops failure modes / trust & anti-gaming) for anything load-bearing.
- `amico plan compile` currently FAILS on this box (no `$AMICO_CRITIC_BIN` / agent CLI).
  Degraded path until it lands: the reviewed spec + parent-tracked steps in the ledger's
  loop log stand in for the compiled plan; gate verdicts still come from real commands
  (test suites, verification scripts), never from the experimenter's say-so.
- **Probe/experiment boundary (mechanical):** read-only ops and bounded side-effect-free
  one-liners (< ~1 min, writes nothing durable, no solve, no test suite) are probes — no
  spec. Writes a durable file, launches a solve, or runs a test suite → experiment → spec.
  Audit rule: a probe whose result is cited in the loop log as experiment evidence was
  misclassified — record the misclassification when caught.

## Handoffs (cross-mode seeds)

The research pack closes by handing an **issue seed** to `develop` (its pack's
closing handoff); this mode RECEIVES a **hypothesis seed** from `develop`.
The procedure, both directions:

- **Receiving (develop → research):** the seed is a typed note
  (`kind: hypothesis`, the hypothesis-seed schema — the question, the
  evidence, the suggested experiment shape). On the seed: re-read the ledger,
  register the hypothesis in the H-queue (§2), and run the loop above on it.
- **Emitting (research → develop):** when a campaign closes with a
  finding that needs code (a validated method, a tool gap, a result that
  wants an implementation), write the issue-seed note — title, motivation,
  evidence pointers, suggested repo + tier — name the target posture
  (develop), and hand it over; the receiving mode's protocol (the `develop`
  skill) renders it through `write-an-issue` and runs the dev walk on it.
- **Switching modes mid-session is not yet specified; the mode cards'
  posture-honesty sections govern until it is.** Until the fork's posture
  surfaces ship, the safe path is to spawn or open the target posture's
  session on the seed rather than switching in place; the ledger discovery
  rule holds either way. Seed-write failures are reported in-chat — never
  silently dropped.

## Compaction honesty

The agent cannot observe its own context usage, and auto-compact fires on a token threshold
with no phase awareness — it WILL fire mid-experiment, unattended. The protocol does not
pretend to time it; it makes any compaction safe at any moment: ledger current at every
boundary including before every cast; in-flight casts recorded with artifact destinations;
experimenter work products are files (a parent compaction cannot destroy an in-flight
experiment, only the parent's own working notes); re-read + audit after every compaction.

## Parallel sessions & shared checkouts

`ledger/campaigns/CHECKOUTS.md` is the project-wide claim registry. Pinned scratch harnesses rot between loops: /tmp trees get cleaned, and shared depots garbage-collect pinned package trees. Before re-using one, verify the worktree SHAs and clean status, check every Manifest tree hash is present, instantiate if not, and assert the Manifest is byte-unchanged afterwards (never resolve). Record this in the run's env log. Re-read it before
casting any experimenter; claim your row; release it when work lands. First-writer-wins;
races are possible and visible — a visible conflict beats a silent double-ownership every
time.

## Standing anti-gaming contract

Production `step` paths only for A/B loop experiments; CRN pairing with f=0-style
invariants; impossibility checks on noise denominators; FD sanity gates on derived
quantities; raw artifacts are the evidence, prose is not. Promotion of any result to
catalog/status is human-only, always.

**Every measured axis carries its own wiring gate** (2026-10, three measured instances:
loop-3 playback-unwired, loop-6 detuning-axis-unwired, loop-10's S2-objective probe) — an
unwired axis returns 0s (or a unit-slip returns ~0.5) and banks a wrong verdict with every
other gate green. A spec whose axis lacks a positive wiring check (loader reproduction,
monotonicity, a closed-form anchor cell) is an incomplete spec; critics reject on this
class. Bonus idiom: a symmetric ±σ telegraph arm's MEAN equals the closed-form single-node
cost exactly — a free wiring validator for detuning axes. Analyzer findings are verified by
the director before being applied (2026-10, a factually-wrong receipts finding was caught);
a critic's arithmetic is never trusted over the test file's machine-pinned literals.

- **Score corrections out of sample.** Under drift drawn fresh each round, a correction fitted at round k and scored at round k is in-sample. Report the one-step-ahead score F(k+1) − F_do-nothing(k+1) beside it. One campaign's entire arm ordering turned out to rank least harm: every arm was worse than doing nothing on 8/8 seeds. Always carry a do-nothing reference, and pair by seed, because pooled medians can reverse paired orderings.
- **Keep every STOP artifact** (rename it `*_STOP`; never delete it). An extra check an experimenter adds is a record, never a pass condition. An unregistered gate is a spec deviation even when it is caught.
- **Run-mode tokens live only in filenames.** Determinism twins must not carry `_det` (or any pass marker) in their content. After the det pass, `grep -F _det` over twinned content must come back empty. This defect broke byte-identity four times in one campaign.
- **Interpretation waits for the analyzer.** The director records a mechanical label at the gate. Its meaning (recommendations, mechanism claims) lands only after the read-only analysis of the raw artifacts.

## Failure modes to watch

- **The thin brief** — a subagent with a fresh context and a vague brief rediscovers
  everything the hard way. Briefs point at files (ledger, notes, specs), never paste prose.
- **The stale ledger** — if §3's uncommitted state is older than the last edit on disk, the
  ledger is lying; refresh it before acting on it.
- **EXHAUSTED debriefs** — an experimenter that hit its step cap reports `EXHAUSTED:`;
  that's an open loop in §5, never an outcome in §2.
- **Summary drift** — after each compaction, the audit in §9 is the check that the summary
  still points HERE rather than becoming a competing source of truth.
- **The silent no-op edit** — programmatic edits that report success but never matched
  (six measured instances, 2026-10): every edit asserts its pattern and grep-verifies the
  critical line; before `git add -A`, inspect status and account for every path (silent
  subagent failures leave partial state that a blind add commits); after multi-edit
  confusion, rewrite clean and let git arbitrate.
- **Unattended runs** — plain `nohup` backgrounds die at tool-call exit in sandboxed
  harnesses; `setsid` survives (measured both ways). Chain unattended cells through a
  driver script; commit the state to the ledger BEFORE the night starts so any compaction
  is safe.
