import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VSIX = join(__dirname, "..", "amicode.vsix");
const REQUIRED = [
  // EVERY bin the CLI package declares ships as launcher + dist bundle (#161 —
  // amico-pasqal was declared but unstaged; cli_gate.test.ts asserts behavior,
  // this list pins vsix presence).
  "extension/bin/dist/amico-run.js",
  "extension/bin/launcher/amico-run",
  "extension/bin/dist/amico.js",
  "extension/bin/launcher/amico",
  "extension/bin/dist/amico-pasqal.js",
  "extension/bin/launcher/amico-pasqal",
  // #399 — the GitHub App identity bins: amico-git-credential (map-declared)
  // and the gh PATH shim (a SHADOW bin — staged beyond the bin map precisely
  // so pnpm cannot link it into node_modules/.bin; that pin lives HERE).
  "extension/bin/dist/amico-git-credential.js",
  "extension/bin/launcher/amico-git-credential",
  "extension/bin/dist/gh.js",
  "extension/bin/launcher/gh",
  // #643 — the bin/-scoped module-type marker: the ESM CLI bundles sit under
  // the typeless VS Code extension manifest; without this file every packaged
  // invocation pays a MODULE_TYPELESS_PACKAGE_JSON reparse. Both refresh
  // paths write it (the extension build's staging AND the server-binary
  // upgrade's dist rebuild) — this pin is the packaged side of that contract.
  "extension/bin/package.json",
  // Pasqal connector assets — staged to <opsDir>/scripts/pasqal-connector at
  // activation (the Connections panel's default validator path, #161). Kept in
  // the vsix by explicit .vscodeignore negations against scripts/**.
  "extension/scripts/pasqal-connector/pasqal_validate.py",
  "extension/scripts/pasqal-connector/requirements.txt",
  "extension/THIRD_PARTY_LICENSES.md", // MIT notice for the vendored opencode binary — must ship (license compliance)
  "extension/readme.md", // marketplace detail-page body (vsce lowercases README.md) — a dropped README = blank listing page

  "extension/templates/solve_template.jl",
  "extension/templates/solve_template_hp.jl", // HP-mode vetted template (Piccolissimo) — mode-selected at prep time
  // spec C authoring assets — the tiered resolver + verification chain break
  // silently if any of these is dropped from the vsix.
  "extension/templates/registry.toml", // tier-1 template registry + support set + sandbox uuid map
  "extension/templates/skeleton_free.jl", // tier-3 free-authoring skeleton (contract + verify snapshot)
  "extension/exemplars/EXEMPLARS.toml", // tier-2 seed (build input)
  "extension/exemplars/index.json", // tier-2 index (the artifact amico-run reads)
  "extension/exemplars/rydberg-cz/script.jl", // the seeded exemplar script the index points at
  "extension/julia/verify_rollout.jl", // fixed re-rollout harness — the tier-3 trust anchor
  "extension/julia/Project.toml",
  "extension/julia/Manifest.toml",
  "extension/AGENTS.md",
  "extension/demo/run/run.toml",
  "extension/demo/run/FINISHED",
  "extension/demo/run/run.log", // inspector reads run.log for the demo's stats row; *.log-gitignored so easy to drop
  "extension/media/brand.css", // style variables (design-owned) — must ship, else an unstyled inspector
  "extension/media/layout.css", // layout selectors (design-owned) — must ship, else an unstyled inspector
  "extension/scores/pulse-designer/SCORE.md", // score #0 — the interview is data; a dropped repertoire = silent prose fallback
  "extension/scores/pulse-designer/templates/solve.jl", // score-local vetted template (lint requires it resolves)
  "extension/scores/memory/free-phase-objective-only.md",
  "extension/scores/entitlements.toml", // entitlement registry — gating breaks silently without it
  "extension/skills/amico-vault/SKILL.md", // the in-repo public skill library (post-amico-plugin) — a dropped skills/ = zero library skills for a Marketplace user
  // #804 — the mode registry: the bundles the activation stager deploys and
  // the doctor probes ship in the vsix; a dropped modes/ = zero staged
  // bundles on every Marketplace machine (packaging.test runs on the built
  // vsix — the pin fires in the package gate).
  "extension/modes/autodev/mode.toml",
  "extension/modes/autodev/pack.toml",
  "extension/modes/autodev/card.md",
  "extension/modes/autoresearch/mode.toml",
  "extension/modes/autoresearch/pack.toml",
  "extension/modes/autoresearch/card.md",
  "extension/modes/release-index.toml",
  // amicode_* plugin (Bun-transpiled .ts, loaded by absolute path) — every sibling
  // is load-bearing: a dropped file silently reverts the session to vanilla opencode.
  "extension/opencode-plugin/amicode_tools.ts",
  "extension/opencode-plugin/amicode_context.ts", // live stack-state injection plugin (system.transform hook)
  "extension/opencode-plugin/stack_state.ts", // its sibling readers/builders (imported by amicode_context)
  "extension/opencode-plugin/entities.ts",
  "extension/opencode-plugin/problems.ts",
  "extension/opencode-plugin/hashes.ts",
  "extension/opencode-plugin/score_guard.ts",
  // SEAM 2 (#699): the regime priors module + its committed data file — a
  // dropped pair silently reverts every calibration recommendation to
  // ledger-only and kills the audit (F2's sensor).
  "extension/opencode-plugin/regime_priors.ts",
  "extension/opencode-plugin/regime_priors_table.json",
];

// Guards against a silently-dropped runtime asset (the β.2 .gitignore-fallback
// trap, generalized). Locally: inert without a built .vsix (run after
// `pnpm --filter amicode package`) so the fast suite stays green. In CI: the
// vsix-gate job (#45) sets AMICODE_REQUIRE_VSIX=1, under which the suite can
// NEVER self-skip — a missing .vsix is a hard failure there, closing the
// perennial "2 skip" false-green.
const REQUIRE_VSIX = process.env.AMICODE_REQUIRE_VSIX === "1";
describe.skipIf(!existsSync(VSIX) && !REQUIRE_VSIX)("packaged VSIX contains runtime assets", () => {
  it("the .vsix exists (hard requirement under AMICODE_REQUIRE_VSIX=1)", () => {
    expect(existsSync(VSIX), `no ${VSIX} — run: pnpm --filter amicode package`).toBe(true);
  });
  it("includes amico-run, template, julia project, AGENTS.md + a vendored opencode", () => {
    const listing = execFileSync("unzip", ["-Z1", VSIX], { encoding: "utf8" });
    for (const p of REQUIRED) expect(listing, `missing ${p}`).toContain(p);
    expect(/extension\/vendor\/opencode\/.+\/opencode/.test(listing), "missing vendored opencode").toBe(true);
  });
  // The in-repo public skill library (packages/extension/skills/) is the ONLY
  // library root a Marketplace user has — if it's dropped, a published
  // extension silently ships with zero library skills. (Post-amico-plugin:
  // skills ship in-repo, not via fetch:skills -> vendor/skills-public.)
  it("ships the in-repo public skill library (extension/skills/)", () => {
    const listing = execFileSync("unzip", ["-Z1", VSIX], { encoding: "utf8" });
    expect(
      /extension\/skills\/.+\/SKILL\.md/.test(listing),
      "no shipped skill SKILL.md — skills/ was excluded from the vsix",
    ).toBe(true);
    // Internal-only names must NEVER appear in the artifact (repo-boundary
    // defense in depth — these live in the armonissima vault now).
    expect(listing).not.toMatch(/extension\/skills\/implement-issue\//);
    expect(listing).not.toMatch(/extension\/skills\/break-into-subissues\//);
  });
});

// Leak guard on the shipped skill library itself (ADR-0003 as amended by spec
// §A1 / ADR-0011, amicode#614 — re-homed from the vendored bundle to the in-repo
// dir). The public/private boundary is now the REPO boundary; these tests red if
// an internal-surfaced skill ever lands in the shipped library, at source rather
// than at extract. The shipped library admits the two shipping tiers — public
// (loads for all) and entitled (stages only for entitled sessions; must carry a
// non-empty entitlement code) — and still hard-refuses `internal`.
const SKILLS_DIR = join(__dirname, "..", "skills");
describe("in-repo skill library — repo-boundary leak guard (ADR-0003 as amended by ADR-0011)", () => {
  it("every shipped SKILL.md carries surface: public or entitled (entitled needs its entitlement code) — the library never ships internal (AC4)", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SKILLS_DIR)) {
      const p = join(SKILLS_DIR, name, "SKILL.md");
      if (!existsSync(p)) continue;
      const m = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
      const surface = m?.[1].match(/^surface:\s*(\S+)/m)?.[1];
      // raw-value capture + quote-strip: `entitlement: ""` must read as EMPTY
      // (the resolver refuses it at runtime; the guard must agree)
      const entitlement = m?.[1].match(/^entitlement:\s*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
      const ok = surface === "public" || (surface === "entitled" && !!entitlement);
      if (!ok) offenders.push(`${name} (surface=${surface ?? "MISSING"}${surface === "entitled" ? ", entitlement MISSING" : ""})`);
    }
    expect(offenders, `non-shippable skills in the shipped library: ${offenders.join(", ")}`).toEqual([]);
  });
  it("the internal dev-workflow skills are absent from the shipped set (AC5 — the repo boundary remains the internal gate)", () => {
    const names = readdirSync(SKILLS_DIR);
    // surface:internal (amico-plugin#52) — they leaked into the public bundle
    // once under the extract pipeline; the repo boundary must not regress.
    // The entitled tier does NOT reopen this door: entitled ships from the
    // same in-repo dir but stages only through the entitlement gate
    // (resolveLibrarySkills); internal stays vault-only, never ships.
    expect(names).not.toContain("implement-issue");
    expect(names).not.toContain("break-into-subissues");
  });
});
