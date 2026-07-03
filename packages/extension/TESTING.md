# Testing the Amicode night build (branch: `aaron/night-l0-pulse-designer`, PR #75)

What this branch adds on top of main: the **pulse-designer interview** (Amico asks, you click),
the **entity rail** (System · Formulation · Run tracked live), **scores** (interview-as-data,
`packages/extension/scores/`), a **branded fork binary** (says AMICODE, H-robot mark, AMICO
question forms, H spinner), **7 `amicode_*` tools**, and a **Rydberg CZ template** alongside the
transmon one. Nothing in main's contracts changed — `amico-run`, run-dir, schemas, inspector are
untouched.

## Prerequisites

- Access to `harmoniqs/amicode` **and** `harmoniqs/opencode` (the private fork mirror — ask Aaron
  if you get a 404), with `gh` CLI authed (`gh auth status`).
- Julia ≥ 1.12 (`curl -fsSL https://install.julialang.org | sh`), Node ≥ 20, `corepack enable`.

## Install (~20 min, dominated by Julia precompile)

```bash
git clone git@github.com:harmoniqs/amicode.git && cd amicode
git checkout aaron/night-l0-pulse-designer
corepack enable && pnpm install
pnpm --filter amicode-v2 package          # builds + fetches the BRANDED binary from the mirror release
bash packages/extension/scripts/install.sh # Julia project + VSIX install + lab.toml
node packages/extension/scripts/healthcheck.mjs   # expect 4/4 ✓
```

**LLM provider:** `opencode auth login` (or `export ANTHROPIC_API_KEY=…`). Without it you get
opencode's free anonymous tier — it works, but expect occasional interview sloppiness (wrong
tool args, protocol drift). A Sonnet-class model is the intended experience.

**Remote-SSH users:** the server port is fixed at **43117** — forward it once in the Ports view;
restarts reuse it.

## What to test (in rough order)

1. **Start screen** — open the Amicode chat: H-robot, AMICODE wordmark, tagline, ①②③, five
   starter chips. Click **"Design a pulse — walk me through it."**
2. **The interview** — Amico should ask ONE question at a time, with clickable **AMICO ·
   Question** forms (options + descriptions + "type your own"). The **entity rail** at the top
   should fill in as you answer (System → Formulation → Run).
3. **Transmon end-to-end** — X gate, defaults (T=10 ns, N=50): solve launches detached, the
   **Run Inspector** pops with the live pulse, expect **F ≥ 0.999** in ~1–2 min warm.
4. **Fast path** — new session, type "optimize an X gate on my transmon, defaults" — should skip
   the interview and launch directly.
5. **Rydberg** — pick "neutral-atom Rydberg" in the interview: expect the *honest scope*
   behavior (System recorded, formulation captured for follow-up — no dead reckoning). An
   **experimental** CZ template exists (`templates/solve_rydberg_cz.jl`, QuEra gate-zone
   params, public-Piccolo-only) but is NOT yet vetted — its first NLP iteration is
   pathologically slow (under investigation); don't wire it into demos yet.
6. **"What can Amicode do?"** — should give the curated capability pitch (no web fetches).
7. **Thinking spinner** — the pulsing H glyph in the header/timeline while the model works.

## Report

- Anything that violates "one question at a time," answers its own question, or contradicts the
  rail state → screenshot + the session transcript to the PR #75 thread.
- Solve failures → attach the run-dir's `run.log` (`~/.amico/runs/default/<runId>/`).
- UX opinions welcome — most of tonight's build was steered live by exactly that.

## Known caveats (honest list)

- Free-tier model is non-deterministic on interview discipline; real creds fix most of it.
- `amicode_ask` is deprecated (native `question` tool replaced it) — old sessions may still show
  its button cards.
- Hardware/calibrate stages are **guided stubs** — no device I/O, and they say so.
- Non-English locales in the chat UI still say OpenCode in places (en is the branded locale and
  the default).
- The fork mirror (`harmoniqs/opencode`) is **private and must stay private** (MIT attribution
  preserved; patch stack documented in `AMICODE-PATCHES.md` there).
