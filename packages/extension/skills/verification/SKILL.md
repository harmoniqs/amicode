---
name: verification
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
agents: []
surface: public
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Quantum-Specific Verifications

### Fidelity Verification
Before claiming a pulse is optimal or ready for catalog:
- **Run fidelity computation** with current Piccolo on the final pulse
- **Compare against catalog incumbents** — is this pulse actually better than what exists?
- **Check across relevant metrics**: infidelity, gate time, robustness
- **Use `duration(pulse)`** not `sum(get_timesteps)` (the latter overcounts by one dt)

### Vault Note Quality Checks
Before claiming a vault note is complete:
- **Frontmatter valid?** All required YAML fields present and correctly typed
- **Required fields present?** (date, tags, platform, gate, status at minimum)
- **Wikilinks correct?** All `[[references]]` point to existing notes or known targets
- **Catalog cross-references?** If pulse result, linked to catalog entry

### Optimization Run Verification
Before claiming an optimization succeeded:
- **Check final infidelity** (not just that the solver converged)
- **Verify constraint satisfaction** (amplitude bounds, slew rates)
- **Compare to warm-start** if one was used — did we actually improve?

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence does not equal evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter does not equal compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion does not equal excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests (Julia):**
```
Use the test skill — run full test suite for the subpackage
Read output: "Test Summary" line, count passes/failures
THEN claim result
```

**Regression tests (TDD Red-Green):**
```
Write test -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass)
NOT: "I've written a regression test" (without red-green verification)
```

**Build:**
```
Run build -> See: exit 0 -> "Build passes"
NOT: "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
Re-read plan -> Create checklist -> Verify each -> Report gaps or completion
NOT: "Tests pass, phase complete"
```

**Agent delegation:**
```
Agent reports success -> Check VCS diff -> Verify changes -> Report actual state
NOT: Trust agent report
```

## Why This Matters

From 24 failure memories:
- your human partner said "I don't believe you" - trust broken
- Undefined functions shipped - would crash
- Missing requirements shipped - incomplete features
- Time wasted on false completion then redirect then rework
- Violates: "Honesty is a core value. If you lie, you'll be replaced."

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
