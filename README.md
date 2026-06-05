# Amicode

A VS Code extension for agentic quantum-control pulse optimization — natural-language chat → LLM-authored Julia solve (Piccolo/Piccolissimo) → live run inspector → per-lab pulse catalog. Deployed onto partner-lab machines; a vendored [opencode](https://github.com/sst/opencode) binary provides the chat/LLM harness.

> ## ⚠️ Source of truth = the design docs, not this code
>
> This repository's **authoritative design lives in the `harmoniqs/amico` vault**, in this order of authority (architecture → context → diagrams → interfaces → planning → plans → specs). When code and docs disagree, **the docs win.** Scope, architecture, and interface changes happen in the vault docs first, then flow to code and issues.

| # | Authority | Location in `harmoniqs/amico` |
|---|-----------|------------------------------|
| 1 | **Architecture + diagrams + interfaces** (container, solve lifecycle, chat→solve→inspector sequence, run-dir contract, provisioning flow, module decomposition §5, dependency graph §7) | [`vault/specs/spec-20260529-amicode-architecture.md`](https://github.com/harmoniqs/amico/blob/main/vault/specs/spec-20260529-amicode-architecture.md) |
| 2 | **Context / requirements** (problem, solution, user stories S1–S38 with acceptance criteria, stable interface contracts, risks) | [`vault/specs/spec-20260529-amicode-prd.md`](https://github.com/harmoniqs/amico/blob/main/vault/specs/spec-20260529-amicode-prd.md) |
| 3 | **Decisions** (decision log D1–D10; 157 resolved/deferred open questions) | [`vault/specs/spec-20260529-amicode-open-questions.md`](https://github.com/harmoniqs/amico/blob/main/vault/specs/spec-20260529-amicode-open-questions.md) |
| 4 | **Project-management plan** (phases β→4, tasks β.1–4.2, per-phase Definition of Done, dependency-ordered parallel-engineer schedule, ~56-pd estimate) | [`vault/plans/plan-20260603-124231-amicode-phased-build.md`](https://github.com/harmoniqs/amico/blob/main/vault/plans/plan-20260603-124231-amicode-phased-build.md) |
| 5 | **Review / QA** (60-agent swarm review; consolidated findings) | [`vault/reviews/review-20260603-amicode-plan-swarm.md`](https://github.com/harmoniqs/amico/blob/main/vault/reviews/review-20260603-amicode-plan-swarm.md) |

Access requires the `harmoniqs/amico` vault repo. (We chose reference-only over copying the docs in, to keep a single source of truth and avoid drift.)

## Status of the code in this repo

`src/` is the **v2 spike** — a working chat→solve→inspector prototype (CLI-direct, after the pivot away from MCP + callback-HTTP). It is a **starting point, not the authority.** Per the design audit (vault decision log D9/D10), the following are explicitly in flux or superseded — do not treat them as canonical:

- **`bin/amico-run`** — being re-architected into the **D9 thin orchestrator** (spawns `julia <script>`, writes `manifest.toml` + `FINISHED` from outside Julia; passes a lab *pointer*, never parsed params). The current flag-parsing form is pre-D9.
- **`spike_solve.jl`** (in the legacy `amico/amicode/julia/` tree, not extracted here) — a **frozen demo spike**, superseded. Production solves are **LLM-authored Julia scripts** using Piccolo's existing public API (`TransmonSystem(; ω, δ, levels)`, `load_pulse`, JLD2 `save`, the Ipopt callback) per **D10** — not a parameterized `spike_solve.jl`.
- **MCP / callback-HTTP references** in `test/` — vestigial from the pre-pivot design; slated for removal.

## Build & distribution

- **Phased build:** see the plan (authority #4). **Phase β (Schuster demo)** is first — gated by packaging/glue (vendor opencode, bundle the solve script, provision the Julia project), not by Julia solver work (which already ships in Piccolo `main`).
- **Issues** are generated from the PRD + plan (authorities #2/#4) via the `amico:prd-to-issues` skill — *driven by the plan's phase/task decomposition, not by reading this spike code* — onto GitHub Projects board #4 (org `harmoniqs`), labeled `phase:β`…`phase:4` + `area:*`.

## Dev quickstart (spike)

```bash
pnpm install
pnpm run build      # esbuild → dist/extension.js
pnpm test           # vscode-shim smoke tests
```

See [`AGENTS.md`](./AGENTS.md) for the in-editor opencode project conventions the extension sets up.
