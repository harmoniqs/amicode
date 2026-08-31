---
name: hypothesis-review
description: Rank open hypotheses by testability and impact. Invoked from researcher Step 0 to prioritize hypothesis-driven experiments.
agents: [researcher]
surface: public
vault_contract:
  folders: [hypotheses]
  frontmatter: [status]
---

# Hypothesis Review

Rank open hypotheses to identify the highest-value experiments.

## Process

1. **Locate hypotheses.** When the system prompt includes an `## Active Research
   Project` block, read from `<project>/ledger/hypotheses/`. Otherwise, glob
   `hypotheses/` across **every mounted vault** in the Armonia stack (see the
   `amico-vault` skill for the mount set and read precedence). Filter for notes
   with `status: open` or `status: untested`.
2. For each hypothesis, read the body and assess:
   - **Impact if confirmed** (numeric): high=3 (unlocks fidelity breakthrough or new platform), medium=2 (improves existing result), low=1 (incremental or niche)
   - **Ease of test** (numeric): easy=3 (1 cold-start experiment), moderate=2 (needs specific setup or 2-3 experiments), hard=1 (requires engineering or new infrastructure)
   - **Priority score** = impact × ease (range 1–9)
3. Sort by priority score descending
4. Return top 3 hypotheses with: title, score breakdown, brief rationale for ranking, suggested experiment approach

## Output Format

```yaml
hypotheses:
  - path: "vault/hypotheses/hypothesis-YYYYMMDD-HHMMSS-topic.md"
    title: "Free-phase may help fluxonium Y gate"
    impact: 3  # high — could unlock new-best on stuck gate
    ease: 3    # easy — 1 cold-start with free_phase=true
    score: 9
    rationale: "Y gate has 3/5 stagnation failures; free-phase proven on other platforms but never tried here"
    suggested_approach: "Cold-start with free_phase=true, cubic 21 knots, same T_init as current best"
  - ...
```

## Edge Cases

- If no hypotheses with `status: open` or `status: untested` exist, return empty list with note: "No open hypotheses to review."
- If all hypotheses require engineering (ease=hard), note this and return them anyway — the researcher may still choose one.
