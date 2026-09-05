# Skill surfaces are three-tier: public ships and loads for all, entitled ships and loads only for entitled sessions, internal stays vault-only

Status: accepted (2026-08-27; content policy amended 2026-09-05 — see the Amendment record)

ADR-0003's two surface tiers amend to three. `public` ships in the .vsix and loads for every
session, as before. `internal` stays exactly as ADR-0003 left it: private-vault content
(armonissima), admitted only by mount presence, never ships. The new tier — `entitled` — is
frontmatter `surface: entitled` plus `entitlement: <code>`. An entitled skill lives in the same
in-repo library as public skills (`packages/extension/skills/`) and ships in the .vsix, but
stages only for sessions whose resolved entitlements include the skill's code. **Entitled is a
STAGING gate, not a location**: the root admission (which directory is scanned, which surfaces
it admits) and the entitlement gate (which codes the session holds) are separate checks, and
the entitled tier adds only the second. The in-repo library root admits `{public, entitled}`;
the vault root admits `{internal}` only.

The gate is a prep-time decision, not a run-gate. `resolveLibrarySkills(roots, entitlements)`
receives the session's resolved entitlements — read from the same `LocalEntitlementProvider`
(`entitlements.toml`) the score repertoire filter already uses — and `prepareOpencodeProject`
passes them through for EVERY session the extension preps, headless included. Staging happens
where the other staging happens — for extension-prepped sessions there is no session shape that
sees the shipped file but skips the gate.

**Known open enforcement point:** the headless server boot lane (the fleet's boot script) rsyncs
the raw VSIX library over its staged tree without the entitlement filter — that lane is the
server-staging convergence slice (resolver-CLI at boot, spec §A1.3/D4), and until it lands,
headless sessions stage entitled-tier content regardless of entitlement. The content policy
(safe-to-possess) makes this an ordering inconsistency, not a confidentiality break; the gate
closes with slice (d).
No LLM anywhere in the gating path: the check is `entitlements.includes(code)`. A missing or
malformed entitlement code is skip + warn (the resolver's standing philosophy — a defective
skill never blocks a session); a well-formed code the session lacks is a silent skip, because
an unentitled session is the normal case, not an error.

**Why:** the `-issimo` packages (entitlement `issimo`) ship to entitled users with zero usage
guidance — nothing in the public library covers them, and the only `-issimo` skills are
`surface: internal` dev skills on private machines. The facts that make a new tier the right
shape: the amicode repo is PUBLIC, so in-repo content is world-readable by construction;
package SOURCE reaches entitled users regardless (Julia is introspectable once instantiated),
so possession of package internals was never the confidentiality boundary — the public repo
is. That collapses "usage is mostly fine if it doesn't give away too much" into a clean split:
**ship usage, keep internals.** An entitlement-gated runtime fetch (the ADR-0003 flip-condition
mechanism) was the wrong tool here — the content already ships in the .vsix; only the loading
needed gating.

**Content policy (the "careful" half — spec §A1.2):** the entitled tier is safe-to-possess by
construction, because it ships world-readable. An entitled skill may teach usage — public-API
constructors, problem shapes, kwargs, idioms, delivery-mode requirements. It may NOT contain
module trees or src/ file paths, architecture or algorithm internals, "how to modify/extend"
recipes, roadmap or cloud-infrastructure detail, or anything whose world-readability would
harm. The test is per line: usage (shippable) vs internals (vault-only). This is a review-time
discipline enforced at PR review by the director + an independent reviewer — the same review
that guards the dev gate — not a mechanical check; the mechanical guards (leak-guard, resolver)
police the tier labels, not the prose. Dev skills split by content kind (2026-09-05 amendment —
see the Amendment record): workflow-level skills are public; package-proprietary dev skills
(`*-dev`) stay internal.

**Considered:** keeping two tiers and putting -issimo usage in package-colocated skills
(rejected — the channel is dormant and usage guidance belongs with the rest of the library's
platform skills); marking the usage skills `internal` (rejected — internal content lives in
the vault and never ships, so entitled users without the vault mount get nothing, which is the
status quo being fixed); `public` with a description-level caveat (rejected — visibility of
proprietary usage guidance is a product decision the surface model should carry, and
description conventions are not a gate). Entitlement-gated fetch of a separate tarball was
rejected above.

**Accepted costs:** two gates to keep consistent across roots, settings overrides, and the
resolver (the per-root `surfaces` list must admit `entitled` before the entitlement check can
matter); the world-readability of .vsix content is enforced by human review against a written
test, so a sloppy entitled skill ships readable until review catches it — the packaging
leak-guard now admits `public` + `entitled` and still hard-refuses `internal`, which keeps the
repo boundary as the mechanical backstop; `entitlement: ""`-style defects degrade to skip+warn,
so a typo'd code surfaces only as a mysteriously-absent skill (the warning names it).

Design of record: spec §Amendment A1 (spec-20260827-162500-skill-lifecycle-governance,
APPROVED-WITH-ADVISORIES). Amends: ADR-0003 (two-tier checkout gate — its root-typing and
mount-presence mechanics carry forward unchanged; only the tier count grows).

Implementation: harmoniqs/amicode#614

---

**Amendment (2026-09-05): content policy — workflow public, package-proprietary gated.** The
final line of the Content policy section is superseded: "Dev skills (`*-dev`) remain internal
unconditionally." now reads workflow-level skills (the dev-workflow/loop-protocol stack:
`director-core`, `develop`, `implement-issue`, `write-an-issue`, `break-into-subissues`) are
public (`surface: public`, in-repo canonical copies that ship and load for every session); only
package-proprietary skills stay gated (usage skills via this record's entitled tier; package
internals, including `*-dev` skills, vault-only internal). The tier machinery of this record is
untouched: the three-tier model, root admission (`{public, entitled}` in-repo, `{internal}`
vault-only), the entitlement staging gate, and the usage-vs-internals per-line test stand as
written — the per-line test IS the package-proprietary boundary the new policy keeps. The slice-3 review
(harmoniqs/amicode#807) applies the usage-vs-internals boundary test to each of the five workflow
skills before they ship. Provenance:
modes-first-class campaign, spec spec-20260905-063000-modes-first-class decision D2,
harmoniqs/amicode#805, per Aaron Trowbridge's standing approval (2026-09-05); supersedes the
"dev skills stay internal" line of session-20260827-skill-lifecycle §10 (annotated in the vault
record); the companion record, amicissimo ADR-0002 (boundary test), is untouched. Review: at PR
review (director + independent reviewer, per the dev gate) — the pass had not run when this note
was written; it completed 2026-09-05: **approved** (independent reviewer, findings tracked:
the slice-3 content lens folded here; the internal-location vocabulary seam tracked as a chore
for the parents' next amendment).
