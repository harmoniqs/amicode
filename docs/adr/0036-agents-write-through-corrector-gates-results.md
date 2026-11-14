# ADR 0036: Agents write through; the corrector, not a human merge, gates results

## Status

Proposed — 2026-10-25. Supersedes the "stage, never promote" clause of the research-loop doctrine.

## Context

The research loop shipped as propose → trusted gate → independent corrector → stage → human promote. The final step made a human merge the only path from agent work to team knowledge. In practice the humans are the bottleneck: on 2026-10-25 the company vault (harmoniqs/armonissima) carried 32 open PRs, the oldest promotions waiting since July, with 16 merges in the prior 30 days. arJev's staged-note loop showed the same failure in miniature: stubs waited two weeks for prose. Knowledge that waits in a queue nobody drains is knowledge the next loop can't start from.

The old clause bundled two different gates. The **corrector gate** is mechanical — re-rollouts and pinned validators decide whether a result is trusted — and it is not a human bottleneck. The **promotion gate** is a human merge, and it is.

## Decision

Retire the human promotion gate; keep the corrector gate. Agents write directly to team mounts. Every write is a git commit naming the agent role, session, and source; a note that fails its type schema is quarantined, never written; humans review after the fact through a weekly digest of agent writes, and git history is the undo. Results enter the catalog when the independent corrector's verdict agrees — that verdict, not a merge, is the admission rule. The loop becomes propose → trusted gate → independent corrector → write → review.

## Alternatives considered

### Paper-engine-only write-through

Rejected. It fixes literature and leaves the same backlog failure on specs, insights, and methods.

### Retire both gates

Rejected. Without the corrector, an agent-produced number becomes team truth with nothing independent to catch it — the failure the loop exists to prevent.

### Faster human review (reminders, SLAs, rotation)

Rejected. PRs waiting since July show the queue is structural: the people who would review are the people doing the research.

## Consequences

- The promote and dream-promote skills become direct writers; the librarian writes and files; nothing waits in a pending state.
- Attribution and schema validation become hard requirements of every team write, because they are now the only screening.
- Review shifts from approval to correction; the weekly digest is the surface that makes that possible.
- The alpha-promotion release act is unrelated and keeps its name.
