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
  // amicode_* plugin (Bun-transpiled .ts, loaded by absolute path) — every sibling
  // is load-bearing: a dropped file silently reverts the session to vanilla opencode.
  "extension/opencode-plugin/amicode_tools.ts",
  "extension/opencode-plugin/entities.ts",
  "extension/opencode-plugin/problems.ts",
  "extension/opencode-plugin/hashes.ts",
  "extension/opencode-plugin/score_guard.ts",
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
  // The bundled OSS skill subset (fetch:skills -> vendor/skills-public) is the
  // ONLY library root a Marketplace user has — if it's dropped, a published
  // extension silently ships with zero library skills.
  it("bundles the leak-guarded public skill subset (vendor/skills-public)", () => {
    const listing = execFileSync("unzip", ["-Z1", VSIX], { encoding: "utf8" });
    expect(listing, "missing bundled skills manifest").toContain("extension/vendor/skills-public/MANIFEST.json");
    expect(
      /extension\/vendor\/skills-public\/skills\/.+\/SKILL\.md/.test(listing),
      "no bundled public skill SKILL.md — fetch:skills did not run or shipped empty",
    ).toBe(true);
  });
});

// Two-tier leak guard on the vendored artifact itself (ADR-0003, amicode#242).
// The bundle root admits {public} only at resolve time (the resolver half is in
// package_skills.test.ts); these tests guard the ARTIFACT — a corrupt extract or
// a mis-pinned lock that smuggled an internal skill must red here, not ship.
const SKILLS_BUNDLE = join(__dirname, "..", "vendor", "skills-public");
const HAVE_BUNDLE = existsSync(join(SKILLS_BUNDLE, "skills"));
describe.skipIf(!HAVE_BUNDLE && !REQUIRE_VSIX)("vendored public skill subset — two-tier leak guard (ADR-0003)", () => {
  it("the vendored bundle exists (hard requirement under AMICODE_REQUIRE_VSIX=1)", () => {
    expect(HAVE_BUNDLE, "no vendor/skills-public — run: pnpm --filter amicode fetch:skills").toBe(true);
  });
  it("every vendored SKILL.md carries surface: public — the bundle never ships internal (AC4)", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(join(SKILLS_BUNDLE, "skills"))) {
      const p = join(SKILLS_BUNDLE, "skills", name, "SKILL.md");
      if (!existsSync(p)) continue;
      const m = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
      const surface = m?.[1].match(/^surface:\s*(\S+)/m)?.[1];
      if (surface !== "public") offenders.push(`${name} (surface=${surface ?? "MISSING"})`);
    }
    expect(offenders, `non-public skills in the vendored bundle: ${offenders.join(", ")}`).toEqual([]);
  });
  it("the re-tagged dev-workflow skills are absent from the vendored set (AC5)", () => {
    const names = readdirSync(join(SKILLS_BUNDLE, "skills"));
    // Re-tagged surface:internal by amico-plugin#52 — present in the public bundle
    // up to skills-public-v1.6.0, absent from the first post-retag release.
    expect(names).not.toContain("implement-issue");
    expect(names).not.toContain("break-into-subissues");
  });
});
