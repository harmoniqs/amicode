// Skill-content drift lint (amicode#586). The audit of record (campaign ledger
// session-20260826-issimo-skill-freshness §7.2/§7.3) found that every existing
// skill gate stops at frontmatter shape / set membership / byte-identity — a
// drifted constructor name in a SKILL.md passed the whole suite green. This
// suite proves the drift-lint harness on fixtures (extractor precision,
// checker verdicts, structural-vs-semantic split, CLI helpers) and enforces
// the STRUCTURAL invariants of the real in-repo public library on CI, with
// zero private dependencies. The full cross-check against real package
// checkouts runs only where they exist (the mount-gated skip pattern from
// package_skills.test.ts).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  extractClaims,
  checkClaims,
  lintSkillsDir,
  parseLintArgs,
  lintExitCode,
  renderSummary,
  renderTextReport,
  type SkillClaim,
} from "../../src/scores/skill_drift_lint";

const FIXTURES = path.resolve(__dirname, "..", "fixtures", "skill-drift");
const FIXTURE_SKILLS = path.join(FIXTURES, "skills");
const FIXTURE_PACKAGES = path.join(FIXTURES, "packages");

function readFixtureSkill(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_SKILLS, name, "SKILL.md"), "utf8");
}

// ---------------------------------------------------------------------------
// extractClaims — conservative, precision-first (issue Key Decision)
// ---------------------------------------------------------------------------

describe("extractClaims", () => {
  it("extracts call-position symbols from a fenced julia block with package context", () => {
    const claims = extractClaims(readFixtureSkill("clean"));
    const makeWidget = claims.find((c) => c.text === "make_widget");
    expect(makeWidget).toMatchObject({ kind: "symbol", source: "julia-fence", packages: ["FixturePkg"] });
    expect(makeWidget!.line).toBeGreaterThan(0);
    // deduped: `make_widget` appears twice in the fence (bare + qualified) but
    // the bare symbol claim is a single entry
    expect(claims.filter((c) => c.text === "make_widget" && c.kind === "symbol")).toHaveLength(1);
    // call-position constructor also captured
    expect(claims.find((c) => c.text === "EmbeddedOperator")).toMatchObject({
      kind: "symbol",
      packages: ["FixturePkg"],
    });
  });

  it("extracts qualified Package.Symbol names (fence: only for imported packages; prose: capitalized left side)", () => {
    const claims = extractClaims(readFixtureSkill("clean"));
    // in-fence qualified ref to an imported package
    expect(claims).toContainEqual(
      expect.objectContaining({ kind: "qualified-symbol", text: "FixturePkg.make_widget", package: "FixturePkg" }),
    );
    // prose backtick with a capitalized module part
    expect(claims).toContainEqual(
      expect.objectContaining({ kind: "qualified-symbol", text: "FixturePkg.Widget", source: "backtick" }),
    );
  });

  it("extracts explicit `using Pkg: name` imports as symbol claims scoped to that package", () => {
    const md = "```julia\nusing FixturePkg: Widget, make_widget\nw = Widget(1)\n```\n";
    const claims = extractClaims(md);
    expect(claims.find((c) => c.text === "Widget")).toMatchObject({ kind: "symbol", packages: ["FixturePkg"] });
    expect(claims.find((c) => c.text === "make_widget")).toBeTruthy();
  });

  it("extracts backticked bang-functions and multi-hump CamelCase symbols from prose", () => {
    const md = "Call `helper_fn!` after building a `PhantomWidget` instance.\n";
    const claims = extractClaims(md);
    expect(claims.find((c) => c.text === "helper_fn!")).toMatchObject({ kind: "symbol", source: "backtick" });
    expect(claims.find((c) => c.text === "PhantomWidget")).toMatchObject({ kind: "symbol", source: "backtick" });
  });

  it("extracts cited repository paths only from backticks in prose, only with a recognized repo prefix", () => {
    const md = [
      "The loader is in `src/widgets.jl` and the spec in `docs/adr/0001-design.md`.",
      "The template is `packages/Legato.jl`.",
    ].join("\n");
    const texts = extractClaims(md)
      .filter((c) => c.kind === "path")
      .map((c) => c.text);
    expect(texts).toEqual(["src/widgets.jl", "docs/adr/0001-design.md", "packages/Legato.jl"]);
  });

  it("extracts relative markdown links as path claims sourced from links", () => {
    const claims = extractClaims(readFixtureSkill("broken-paths"));
    expect(claims).toContainEqual(
      expect.objectContaining({ kind: "path", text: "missing-companion.md", source: "link" }),
    );
    const clean = extractClaims(readFixtureSkill("clean"));
    expect(clean).toContainEqual(
      expect.objectContaining({ kind: "path", text: "companion.md", source: "link" }),
    );
  });

  it("skips frontmatter entirely (no claims from the YAML header)", () => {
    const claims = extractClaims(readFixtureSkill("clean"));
    expect(claims.some((c) => c.text === "engineer" || c.text === "public")).toBe(false);
  });

  it("is precision-first: noise shapes produce no claims", () => {
    const md = [
      "Standard markdown links `[text](url)` do not work.",
      "Track it in `CONTEXT.md` and `sessions/CHECKOUTS.md`.",
      "Entries live at `catalog/pulses/<id>/metadata.toml` and `./learning-records/*.md`.",
      "Meeting notes go in `amico/vault/.dream-state.toml`.",
      "The generic `name` and `path` fields, plus `T`, `N`, and `GATES`.",
    ].join("\n");
    const claims = extractClaims(md);
    // CONTEXT.md must NOT read as qualified symbol Package.md; vault-layout
    // paths and glob/placeholder paths must not read as repo paths; lowercase
    // prose words and single-hump/all-caps tokens are not symbol claims.
    expect(claims).toEqual([]);
  });

  it("ignores julia Base callables and qualified refs to non-imported modules inside fences", () => {
    const md = [
      "```julia",
      "using LinearAlgebra",
      "println(\"=== dims: $(size(H_drift)) ===\")",
      "BLAS.set_num_threads(1)",
      "x = string(length(a), maximum(b), typeof(c))",
      "```",
    ].join("\n");
    expect(extractClaims(md)).toEqual([]);
  });

  it("does not extract paths from string literals inside julia fences", () => {
    const md = "```julia\npulse, meta = load_traj(\"runs/foo/pulse.jld2\")\n```\n";
    const claims = extractClaims(md);
    expect(claims.find((c) => c.text === "load_traj")).toBeTruthy();
    expect(claims.filter((c) => c.kind === "path")).toEqual([]);
  });

  it("ignores non-julia code fences entirely", () => {
    const md = "```bash\nmake_widget --flag /src/nope.jl\n```\n";
    expect(extractClaims(md)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkClaims — VERIFIED / DRIFTED / UNVERIFIABLE with evidence
// ---------------------------------------------------------------------------

describe("checkClaims", () => {
  const cleanDir = path.join(FIXTURE_SKILLS, "clean");

  it("VERIFIED for an exported symbol, with export-scan evidence", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "make_widget", packages: ["FixturePkg"], line: 1, source: "julia-fence" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("VERIFIED");
    expect(r.evidence).toMatch(/export/i);
    expect(r.evidence).toContain("FixturePkg");
  });

  it("VERIFIED for a source-only (unexported) symbol, with a file:line pointer", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "helper_thing", packages: ["FixturePkg"], line: 1, source: "julia-fence" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("VERIFIED");
    expect(r.evidence).toMatch(/extra\.jl/);
  });

  it("DRIFTED for a symbol absent from its scoped package", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "PhantomWidget", packages: ["FixturePkg"], line: 7, source: "julia-fence" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("DRIFTED");
    expect(r.evidence).toContain("PhantomWidget");
  });

  it("DRIFTED for an unqualified symbol absent from every package under the roots", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "MissingType", packages: [], line: 3, source: "backtick" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("DRIFTED");
  });

  it("VERIFIED for an unqualified symbol found in ANY package (no context, global scan)", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "helper_fn!", packages: [], line: 1, source: "backtick" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("VERIFIED");
    expect(r.evidence).toContain("OtherPkg");
  });

  it("UNVERIFIABLE when the cited package is absent from all roots", () => {
    const [r] = checkClaims([{ kind: "qualified-symbol", text: "GhostPkg.thing", package: "GhostPkg", line: 1, source: "backtick" }], [FIXTURE_PACKAGES]);
    expect(r.verdict).toBe("UNVERIFIABLE");
    expect(r.evidence).toContain("GhostPkg");
  });

  it("UNVERIFIABLE for unqualified symbols when no package roots are given", () => {
    const [r] = checkClaims([{ kind: "symbol", text: "anything", packages: [], line: 1, source: "backtick" }], []);
    expect(r.verdict).toBe("UNVERIFIABLE");
  });

  it("qualified prose claims resolve against the named package", () => {
    const [ok] = checkClaims([{ kind: "qualified-symbol", text: "FixturePkg.Widget", package: "FixturePkg", line: 1, source: "backtick" }], [FIXTURE_PACKAGES]);
    expect(ok.verdict).toBe("VERIFIED");
    const [bad] = checkClaims([{ kind: "qualified-symbol", text: "FixturePkg.phantom_fn", package: "FixturePkg", line: 1, source: "backtick" }], [FIXTURE_PACKAGES]);
    expect(bad.verdict).toBe("DRIFTED");
  });

  it("path claims: VERIFIED under a package (any <Pkg>.jl), under the skill dir, and under extra search roots", () => {
    // package-relative
    const [pkg] = checkClaims([{ kind: "path", text: "src/widgets.jl", packages: [], line: 1, source: "backtick" }], [FIXTURE_PACKAGES], { skillDir: cleanDir });
    expect(pkg.verdict).toBe("VERIFIED");
    expect(pkg.evidence).toContain("FixturePkg.jl");
    // skill-relative companion
    const [skill] = checkClaims([{ kind: "path", text: "companion.md", packages: [], line: 1, source: "backtick" }], [], { skillDir: cleanDir });
    expect(skill.verdict).toBe("VERIFIED");
    // extra search root (library root / repo root passed by the caller)
    const [root] = checkClaims([{ kind: "path", text: "skills/clean/companion.md", packages: [], line: 1, source: "backtick" }], [], { searchRoots: [FIXTURE_SKILLS] });
    expect(root.verdict).toBe("VERIFIED");
  });

  it("path claims: DRIFTED when found nowhere, with the checked candidates in the evidence", () => {
    const [r] = checkClaims([{ kind: "path", text: "src/missing.jl", packages: [], line: 5, source: "backtick" }], [FIXTURE_PACKAGES], { skillDir: path.join(FIXTURE_SKILLS, "broken-paths") });
    expect(r.verdict).toBe("DRIFTED");
    expect(r.evidence).toContain("src/missing.jl");
  });

  it("path claims: UNVERIFIABLE with no roots and no skill dir", () => {
    const [r] = checkClaims([{ kind: "path", text: "src/whatever.jl", packages: [], line: 1, source: "backtick" }], []);
    expect(r.verdict).toBe("UNVERIFIABLE");
  });
});

// ---------------------------------------------------------------------------
// lintSkillsDir — structural failures vs semantic drift (report-mode)
// ---------------------------------------------------------------------------

describe("lintSkillsDir", () => {
  it("clean skill: ok, zero structural failures, all claims VERIFIED", () => {
    const report = lintSkillsDir(path.join(FIXTURE_SKILLS, "clean"), [FIXTURE_PACKAGES]);
    expect(report.ok).toBe(true);
    expect(report.aggregate.structuralFailures).toBe(0);
    expect(report.aggregate.drifted).toBe(0);
    expect(report.aggregate.unverifiable).toBe(0);
    expect(report.aggregate.verified).toBeGreaterThan(0);
    expect(report.skills[0].name).toBe("clean");
  });

  it("drifted skill: semantic DRIFTED claims reported but ok stays true (report-mode)", () => {
    const report = lintSkillsDir(path.join(FIXTURE_SKILLS, "drifted"), [FIXTURE_PACKAGES]);
    expect(report.ok).toBe(true);
    expect(report.aggregate.drifted).toBeGreaterThanOrEqual(3); // PhantomWidget (fence+prose), phantom_fn (fence+prose)
    const driftedTexts = report.skills[0].claims.filter((c) => c.verdict === "DRIFTED").map((c) => c.claim.text);
    expect(driftedTexts).toContain("PhantomWidget");
    expect(driftedTexts).toContain("FixturePkg.phantom_fn");
  });

  it("malformed frontmatter is a STRUCTURAL failure (non-zero exit semantics)", () => {
    const report = lintSkillsDir(path.join(FIXTURE_SKILLS, "malformed"), []);
    expect(report.ok).toBe(false);
    expect(report.skills[0].structural.join()).toMatch(/frontmatter/i);
  });

  it("a broken relative link within the skills tree is a STRUCTURAL failure", () => {
    const report = lintSkillsDir(path.join(FIXTURE_SKILLS, "broken-paths"), [FIXTURE_PACKAGES]);
    expect(report.ok).toBe(false);
    expect(report.skills[0].structural.join()).toMatch(/missing-companion\.md/);
    // while the broken PACKAGE path stays semantic (report-mode)
    expect(report.skills[0].claims.find((c) => c.claim.text === "src/missing.jl")?.verdict).toBe("DRIFTED");
  });

  it("duplicate frontmatter names across skill dirs are STRUCTURAL failures on the later skill (sorted order)", () => {
    const report = lintSkillsDir(FIXTURE_SKILLS, [FIXTURE_PACKAGES]);
    const dupTwo = report.skills.find((s) => s.skill === "dup-two")!;
    expect(dupTwo.structural.join()).toMatch(/duplicate.*duplicated.*dup-one/i);
    const dupOne = report.skills.find((s) => s.skill === "dup-one")!;
    expect(dupOne.structural).toEqual([]);
  });

  it("aggregate counts every skill and structural failure in the mixed fixture tree", () => {
    const report = lintSkillsDir(FIXTURE_SKILLS, [FIXTURE_PACKAGES]);
    expect(report.skills.map((s) => s.skill)).toEqual([
      "broken-paths",
      "clean",
      "drifted",
      "dup-one",
      "dup-two",
      "malformed",
    ]);
    expect(report.aggregate.skills).toBe(6);
    // structural: broken link (1) + malformed frontmatter (1) + duplicate name (1)
    expect(report.aggregate.structuralFailures).toBe(3);
    expect(report.ok).toBe(false);
  });

  it("structuralOnly: link refs still checked, package cross-check skipped entirely (the CI lane)", () => {
    const report = lintSkillsDir(FIXTURE_SKILLS, [], { structuralOnly: true });
    // broken link still structural
    expect(report.skills.find((s) => s.skill === "broken-paths")!.structural.join()).toMatch(/missing-companion\.md/);
    // drifted skill's claims are NOT checked (no package cross-check at all)
    const drifted = report.skills.find((s) => s.skill === "drifted")!;
    expect(drifted.claims).toEqual([]);
    expect(report.aggregate.verified).toBe(0);
    expect(report.aggregate.drifted).toBe(0);
    expect(report.aggregate.unverifiable).toBe(0);
  });

  it("is deterministic: the same inputs produce deep-equal reports", () => {
    const a = lintSkillsDir(FIXTURE_SKILLS, [FIXTURE_PACKAGES]);
    const b = lintSkillsDir(FIXTURE_SKILLS, [FIXTURE_PACKAGES]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a missing skills dir yields an empty (ok) report, no throw", () => {
    const report = lintSkillsDir(path.join(os.tmpdir(), "amicode-no-such-skills-dir"), []);
    expect(report.skills).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("skill reports carry per-claim verdict evidence with claim location", () => {
    const report = lintSkillsDir(path.join(FIXTURE_SKILLS, "drifted"), [FIXTURE_PACKAGES]);
    const drifted = report.skills[0].claims.filter((c) => c.verdict === "DRIFTED");
    for (const r of drifted) {
      expect(r.claim.line).toBeGreaterThan(0);
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI helpers (pure; the .mts runner is smoke-run below where node can strip types)
// ---------------------------------------------------------------------------

describe("CLI helpers", () => {
  it("parseLintArgs: defaults (json report, no package roots, structural checks on)", () => {
    const parsed = parseLintArgs([], { defaultSkillsDir: "/tmp/skills" });
    expect(parsed).toEqual({
      skillsDir: "/tmp/skills",
      packageRoots: [],
      structuralOnly: false,
      reportFormat: "json",
      outFile: undefined,
    });
  });

  it("parseLintArgs: --skills, repeatable and comma-separated --packages, flags", () => {
    const parsed = parseLintArgs(
      ["--skills", "/s", "--packages", "/a", "--packages", "/b,/c", "--structural-only", "--report", "text", "--out", "r.json"],
      { defaultSkillsDir: "/tmp/skills" },
    );
    expect(parsed).toEqual({
      skillsDir: "/s",
      packageRoots: ["/a", "/b", "/c"],
      structuralOnly: true,
      reportFormat: "text",
      outFile: "r.json",
    });
  });

  it("parseLintArgs: unknown flag or missing value → error object", () => {
    expect(parseLintArgs(["--wat"], { defaultSkillsDir: "/s" })).toHaveProperty("error");
    expect(parseLintArgs(["--skills"], { defaultSkillsDir: "/s" })).toHaveProperty("error");
    expect(parseLintArgs(["--report", "yaml"], { defaultSkillsDir: "/s" })).toHaveProperty("error");
  });

  it("lintExitCode: non-zero ONLY for structural failures; drift alone exits 0", () => {
    expect(lintExitCode(lintSkillsDir(path.join(FIXTURE_SKILLS, "drifted"), [FIXTURE_PACKAGES]))).toBe(0);
    expect(lintExitCode(lintSkillsDir(FIXTURE_SKILLS, []))).toBe(1);
    expect(lintExitCode(lintSkillsDir(path.join(FIXTURE_SKILLS, "clean"), [FIXTURE_PACKAGES]))).toBe(0);
  });

  it("renderSummary: short human summary with counts", () => {
    const report = lintSkillsDir(FIXTURE_SKILLS, [FIXTURE_PACKAGES]);
    const s = renderSummary(report);
    expect(s).toMatch(/skills/i);
    expect(s).toMatch(/structural/i);
    expect(s).toMatch(/drifted/i);
    expect(s.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("renderTextReport: per-skill listing with verdicts", () => {
    const text = renderTextReport(lintSkillsDir(path.join(FIXTURE_SKILLS, "drifted"), [FIXTURE_PACKAGES]));
    expect(text).toContain("drifted");
    expect(text).toContain("DRIFTED");
    expect(text).toContain("PhantomWidget");
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end (runs only under a node with native TS type-stripping — the
// nightly host; skips cleanly on older node like CI's node 20)
// ---------------------------------------------------------------------------

const NODE_STRIPS_TYPES = (process.features as { typescript?: string } | undefined)?.typescript === "strip";
(NODE_STRIPS_TYPES ? describe : describe.skip)("CLI end-to-end (scripts/skill_drift_lint.mts)", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..");
  const CLI = path.join(EXT_ROOT, "scripts", "skill_drift_lint.mts");

  it("emits a JSON report on stdout, a summary on stderr, exit 0 for a clean tree", () => {
    const cleanTree = fs.mkdtempSync(path.join(os.tmpdir(), "skill-lint-cli-"));
    fs.cpSync(path.join(FIXTURE_SKILLS, "clean"), path.join(cleanTree, "clean"), { recursive: true });
    try {
      const r = spawnSync(process.execPath, [CLI, "--skills", cleanTree, "--packages", FIXTURE_PACKAGES], {
        encoding: "utf8",
        cwd: EXT_ROOT,
      });
      expect(r.status).toBe(0);
      const report = JSON.parse(r.stdout);
      expect(report.ok).toBe(true);
      expect(report.skills[0].skill).toBe("clean");
      expect(report.aggregate.verified).toBeGreaterThan(0);
      expect(r.stderr).toMatch(/skills/i);
    } finally {
      fs.rmSync(cleanTree, { recursive: true, force: true });
    }
  });

  it("exits non-zero for structural failures and lists them in the JSON", () => {
    const r = spawnSync(process.execPath, [CLI, "--skills", FIXTURE_SKILLS, "--packages", FIXTURE_PACKAGES], {
      encoding: "utf8",
      cwd: EXT_ROOT,
    });
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.aggregate.structuralFailures).toBe(3);
    expect(r.stderr).toMatch(/structural/i);
  });
});

// ---------------------------------------------------------------------------
// The REAL public library — CI lane (structural only, zero private deps) and
// the mount-gated full cross-check (package_skills.test.ts skip pattern)
// ---------------------------------------------------------------------------

const REAL_SKILLS = path.resolve(__dirname, "..", "..", "skills");
/** Real Harmoniqs Julia package checkouts (~/armonia/repos/packages). Present
 *  only on fleet machines — CI does not have them — so full cross-check
 *  assertions skip cleanly when absent. */
function realPackagesRoot(): string | null {
  const root = path.join(os.homedir(), "armonia", "repos", "packages");
  return fs.existsSync(root) ? root : null;
}

describe("real public library (packages/extension/skills)", () => {
  it("passes the structural lint with zero private dependencies (CI lane)", () => {
    const report = lintSkillsDir(REAL_SKILLS, [], { structuralOnly: true });
    expect(report.ok).toBe(true);
    expect(report.aggregate.skills).toBeGreaterThan(10);
    // no private roots touched: zero claim checking happened
    expect(report.aggregate.verified + report.aggregate.drifted + report.aggregate.unverifiable).toBe(0);
  });

  it("full cross-check runs where real package checkouts exist, skips cleanly otherwise", () => {
    const root = realPackagesRoot();
    if (!root) return; // CI / fresh installs — mount-gated skip
    const report = lintSkillsDir(REAL_SKILLS, [root]);
    // the cross-check must not turn structural-red (structure is CI's hard gate)
    expect(report.ok).toBe(true);
    const verdicts = new Set(["VERIFIED", "DRIFTED", "UNVERIFIABLE"]);
    for (const s of report.skills) {
      for (const c of s.claims) expect(verdicts.has(c.verdict)).toBe(true);
      expect(c_verdictShape(c.claim)).toBe(true);
    }
    // and it actually checked something (the library cites real API names)
    expect(report.aggregate.verified + report.aggregate.drifted + report.aggregate.unverifiable).toBeGreaterThan(0);
  });
});

function c_verdictShape(claim: SkillClaim): boolean {
  return typeof claim.text === "string" && claim.text.length > 0 && claim.line > 0;
}
