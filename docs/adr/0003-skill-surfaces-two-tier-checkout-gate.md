# Internal library skills resolve only from the private plugin checkout

Status: accepted (2026-08-02)

Skill surfaces are two-tier. The extension's library-skill resolver admits `surface: internal` skills when — and only when — they resolve from the developer's private plugin checkout (the first library root); the vendored public bundle (the fallback root, and the only root a Marketplace user has) admits `surface: public` only. This reverses the resolver's previously documented invariant that there is no library-level entitlement seam.

**Why:** `brainstorming` cannot run end-to-end in Amicode — its publish primitive (`write-an-issue`) and decompose step (`break-into-subissues`) are internal-tagged and the public-only resolver gives internal skills no path at all, while team policy keeps dev-workflow skills internal rather than scrubbing them for the public artifact. Checkout presence is the right gate because content possession is the proof: internal `SKILL.md` files exist only in the private repo, so no user can stage internal skills they do not already have, and every team member has the checkout per onboarding. The seam is per-root surface eligibility (library roots become typed: path plus admitted surfaces), not an entitlement check — nothing is downloaded, minted, or verified at runtime.

**Considered:** scrubbing the dev-workflow skills to `surface: public` (rejected — violates the keep-internal policy and genericizing the org machinery would gut the skills); an entitlement-gated runtime fetch of a second, internal tarball (rejected — new release and download machinery whose only benefit is team users without a checkout, who do not exist); keeping public-only resolution (rejected — `brainstorming` stays dangling at its publish step).

**Accepted costs:** two surface semantics to maintain across the extract pipeline (tag-level) and the resolver (root-level); the settings-level library-root override changes value shape (typed roots) and needs a back-compat note; Marketplace users lose `implement-issue` and `break-into-subissues` at the next public release — intended by policy, but a visible removal. The resolver keeps dropping `internal` at the bundle root as defense in depth even though the extract script plus leak-guard already guarantee it.

**Flip condition:** if Amicode ships to team users who need internal skills but have no plugin checkout, revisit toward the runner-up (entitlement-gated fetch of an internal tarball through the profile machinery).
