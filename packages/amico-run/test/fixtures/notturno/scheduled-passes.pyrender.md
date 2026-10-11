---
type: dashboard
subtype: scheduled-passes
source: notturno
---

# Scheduled passes

One record per Notturno scheduled pass, newest at the bottom. Written only by
`python -m automation.notturno.passes` (single-writer rule, ADR 0001).

## Pass 2026-10-01 — canary — ok

- staging slots clean
- duration: 42s
- artifacts:
  - https://example.test/run/1

## Pass 2026-10-01 — fleet-digest — failed

- mini unreachable

## Pass 2026-10-01 — only — ok

- o
