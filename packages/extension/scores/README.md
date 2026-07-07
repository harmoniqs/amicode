# The repertoire — authoring scores

A **score** is a packaged guided path: the interview a user rides from intent to a
result. Scores are **content, not code** — adding a user path means adding a
directory here; the runtime never changes. (Naming: Amico is the conductor; it
performs scores; this directory is its repertoire.)

```
scores/
  entitlements.toml        # registered entitlement ids (typos fail CI)
  memory/<slug>.md         # bundled [Why?] hook content, shared across scores
  <score-id>/
    SCORE.md               # the manifest (YAML frontmatter) + Amico's voice (body)
    templates/*.jl|*.py    # vetted templates the score's stages instantiate
```

## SCORE.md anatomy

Frontmatter = structure (what the runtime, UI, lint, and tests read).
Body = prose (per-stage narration, physics, defaults rationale, off-path guidance).

```yaml
---
type: score
schema_version: 1 # supported: 1; unknown FIELDS are ignored (additive policy)
id: my-score # directory name must match
version: 1 # bump on revision; in-flight sessions stay pinned to theirs
derived_from: null # or a sibling score id — lineage for forks
name: "Shown on the entry card"
outcome: "What the user will HAVE at the end"
audience: [algorithms, no-physics-assumed]
duration_estimate: "60–90 min"
device: { backend: pasqal, qpu_runnable: true, emulators: [emu-mps] } # optional
entitlements: [] # empty/absent = public; ids must be in entitlements.toml
stages:
  - id: application # ordered list; loopbacks OK, no DAGs (v1)
    emits:
      [circuit] # ONLY workflow-frames entities: circuit, system,
      # formulation, pulse, run, device_session, knowledge
    questions:
      - id: graph
        prompt: "Which graph?"
        choices: [sample, upload] # choices → rendered as amicode_ask buttons
        default: sample # must be one of choices; marked "(recommended)"
        skip_if: "mode == simulate" # optional
        memory_hooks: [some-slug] # optional; must resolve to memory/<slug>.md
  - id: solve
    emits: [run, pulse]
    executor: cloud-altissimo # or local
    template: templates/solve.jl # resolved relative to the score dir; must exist
  - id: device-qpu
    emits: [device_session]
    gate: heavy # light|heavy — checks must pass BEFORE entering
    optional: true
---
[Amico's voice for this score — markdown + LaTeX, carried verbatim into the prompt]
```

## Rules the lint enforces (`pnpm --filter amicode-v2 test -- repertoire_lint`)

- manifest validates (schema_version supported, version ≥ 1, no duplicate stages,
  defaults ∈ choices, `emits` only known entities, `gate` only known classes)
- every `template` resolves inside the score dir
- every `memory_hooks` slug resolves to `scores/memory/<slug>.md`
- `derived_from` is null or an existing score id
- every entitlement id is registered in `entitlements.toml`
- new files ship in the .vsix (`test/packaging.test.ts`)

## How it runs ("data-defined, prompt-executed")

At session prep, `prepareOpencodeProject` loads the repertoire, filters it by the
user's entitlements (no code → public scores only; failures fall back to public —
never a dead end), compiles the selected score + the onset router into the injected
AGENTS.md, and writes `score_manifest.json` for the Bun-side plugin. The `amicode_*`
tools enforce stage order and gates against that manifest (entity dependencies
block; conversational stages don't) and record `interview_state.json` +
`usage.jsonl` — the funnel data future learned-traversal work consumes.

If score loading fails, the runtime falls back to the hardcoded interview section
in `AGENTS.md` — a broken score can never brick the boot (and a broken score is
skipped, not fatal, in the repertoire).

## Known v1 limits

- **Score selection is boot-time** (score #0). Multi-score repertoires need the
  router-time select→recompile step — see the scores-runtime handoff note.
- Stage funnel events come from tool-mapped stages; purely conversational stages
  aren't individually tracked yet.
