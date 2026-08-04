---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
agents: []
surface: public
stub: true
---

# grill-me — superseded by grill-with-docs

This skill has been folded into [`grill-with-docs`](../grill-with-docs/SKILL.md), which does
everything the original `grill-me` did — relentless one-branch-at-a-time interviewing, exploring
the codebase to answer questions instead of asking them — **plus** it challenges the plan against
the project's domain model (`CONTEXT.md`), sharpens terminology, and records load-bearing
decisions as ADRs inline.

**Use `/grill-with-docs` instead.** This stub is retained only so the "grill me" trigger phrase
still routes somewhere; it carries no separate behaviour.
