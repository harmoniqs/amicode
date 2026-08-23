# Doctor v2 fixture suite — authorship record

The verdict-matrix suite lives in `packages/amico-run/test/surfaces.test.ts`
(world builder: `test/helpers.ts`, `buildDoctorWorld`). This file records the
authorship split the issue's Testing Decisions pin: **implementer authors the
matrix cells; the reviewer adds adversarial variants.**

## Implementer cells (this slice, #525)

Every cell asserts its EXPECTED verdict, not mere record presence:

| Cell | Fixture mechanism |
| --- | --- |
| current × 6 | healthy world; fake binaries print far-future build dates (`209901010000`), git commits pinned `2026-08-01T12:00:00Z` |
| server-binary stale (version-stale) | frozen binary prints far-past build date (`202601010000`) < pinned HEAD commit date |
| server-binary stale (running ≠ frozen) | `--running-binary` stub with different bytes → different sha |
| server-binary stale (server-down) | injected `discoverRunning: () => null` (never the live ps) |
| extension stale | version bump pushed to the bare remote from a throwaway clone — the checkout learns of it only via doctor's fetch |
| vendored-binary stale | new release tag `v1.18.12-amicode.1` pushed to the fork bare remote |
| staged-skills stale | one staged skill's content drifted (per-skill digest diff names it) |
| agent-cards stale | three variants: tampered deployed card · receipt missing (bytes match — the receipt is the staleness) · receipt source digests lie |
| integrity-failure | sidecar rewritten with a wrong digest |
| unknown × 6 | dead-remote stubs (`remote set-url` → nonexistent path) for server-binary fork / extension amicode remote / vendored release tag; missing-local-source for staged-skills + both agent-cards records |
| degradation proof | every source dead → six `unknown` records, report never fails |

Determinism: no mtime is read anywhere; "newest" is version-sorted (the
current-world fixture writes the 0.2.4 VSIX dir AFTER 0.2.6 so its mtime is
newer — the probe must still pick 0.2.6).

## Reviewer adversarial variants (to be added in review)

Slots deliberately left open for the reviewer pass, per the house pattern:

- server-binary: missing frozen binary / missing sidecar / unexecutable binary
- extension: installed AHEAD of origin/main; VSIX dirs with unparseable versions
- vendored: release-tag ordering (`-amicode.2` vs `-amicode.10`); binary
  printing prerelease strings
- staged-skills: skill present in staging but absent from the VSIX set (extra
  skill); staged dir entirely missing
- agent-cards: extra deployed cards not in sources; unparseable receipt
- version strings: `0.0.0-local/amicode-<12 digits>` variants that defeat the
  build-date parser

Hermeticity: every fixture injects temp roots (tracked + cleaned via
`cleanupTracked`); the real `~/.amico`, `~/.vscode`, and `~/armonia` are never
touched; git "remotes" are local bare repos inside the temp world.
