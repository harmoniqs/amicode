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

## Reviewer adversarial variants — pass 2026-08-23 (gate discharged)

**reviewer pass 2026-08-23: 14 adversarial variants added; findings: 2 real
predicate gaps (extra staged skill / extra deployed card both judged
`current` by the one-directional digest loops), fixed minimally in
`src/surfaces.ts` and pinned; 1 prediction wrong (13-digit build stamp — the
parser's year guard rejects it), noted, not added.**

### Findings — real predicate gaps, fixed + pinned

1. **staged-skills extra skill**: a skill present in staging but absent from
   the VSIX set was judged `current` — the digest loop ran source→staged
   only, and the set digest silently excluded the extra (version equalled
   source_version while the deployed set had drifted). Fix: extras are
   flagged → `stale`, named in evidence, and count toward the staged set
   digest.
2. **agent-cards extra deployed card**: the same one-directional loop; an
   extra deployed `.md` card was judged `current`. Fixed identically.

   Direction ruling for both: extras are `stale`, not `unknown` — the source
   of truth is fully readable and the drift is a local hard fact, repairable
   by redeploy (the module's own "local facts outrank unknown" invariant).

### Variants added (every one verified against the real probes first)

| Variant | Pinned verdict |
| --- | --- |
| extra staged skill (reverse-direction drift) | stale — was `current` before the fix |
| extra deployed agent card (reverse-direction drift) | stale — was `current` before the fix |
| uppercase-hex sidecar digest | current (normalized, case-insensitive match) |
| build date exactly == HEAD commit date | current (staleness is strict `<`) |
| extension dirs 0.2.10 vs 0.2.9 | current via 0.2.10 (numeric sort; lexicographic flips) |
| release tags v1.18.10-amicode.2 vs v1.18.9-amicode.15 | current (numeric sort → base 1.18.10) |
| reachable fork remote, zero release tags | unknown (per-surface; server-binary stays current) |
| unexecutable frozen binary (chmod 644) | integrity-failure (`--version failed`) |
| extension installed ahead of origin/main | stale ("ahead" evidence) |
| vendored `--version` trailing whitespace | current (trimmed) |
| frozen binary missing | stale (absent surface = repairable) |
| sidecar missing while binary present | integrity-failure |
| staged skills dir entirely missing | stale |
| unparseable deploy receipt | stale (bytes match — the receipt is the staleness) |

Probed and NOT added: a 13-digit build stamp (`…-2026080112000`) was
predicted to misparse as a year-260 date and flip the verdict to stale — it
does not: the parser's `y < 2000` guard rejects the shifted window, and the
verdict is `current` with honest "build date unparseable" evidence
(prediction wrong; out-of-contract input, no action). Ruled out without a
fixture: unparseable VSIX dir names (versionPrefix falls to "", sorts oldest
— or stale-behind when alone) and prerelease `--version` strings (judged
stale "ahead" of the release-tag base, which is defensible).

Hermeticity: every fixture injects temp roots (tracked + cleaned via
`cleanupTracked`); the real `~/.amico`, `~/.vscode`, and `~/armonia` are never
touched; git "remotes" are local bare repos inside the temp world.
