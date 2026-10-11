// #1668 — the amico-run doc-reference sweep. The bin is deleted (#1667) and
// `amico run` is the byte-for-byte equivalent; the five-verb surface
// (AUTHOR·EXECUTE·VERIFY·REMEMBER·METER) is the approved vocabulary (A1′,
// the Aug-17 dissolution). Docs must stop TEACHING `amico-run` as a command —
// the agent surfaces that still say `amico-run --spec …` spawn a bin that no
// longer exists.
//
// The rule this test enforces: every occurrence of `amico-run` in the DOC
// surface (the repo's docs + the extension's shipped agent-taught content)
// must be one of
//   1. the PACKAGE spec — `@amicode/amico-run` (the package survives the
//      sunset this cycle; only the BIN died),
//   2. a FOLDER PATH — `packages/amico-run/…` or an `amico-run/…` segment
//      (`pnpm --filter` specs, dist/ launcher paths, fixture paths),
//   3. a HISTORICAL mention — provenance framing ("the amico-run bin was
//      deleted", "superseded the amico-run CLI", receipts). History stays;
//      active teaching dies.
// Anything else is a violation: a taught command, a named runner, a shim in
// a taught launcher set.
//
// Deliberately OUT of the doc surface (see each exclusion's reason):
//   - packages/amico-run/** — the implementing package; its internals,
//     self-referential design comments, and fixtures are its own suite's
//     territory (the folder name survives, #1667's ruling).
//   - packages/extension/src/** + opencode-plugin/** — code, already pinned
//     by amico_run_bin_retirement.test.ts (#1667).
//   - docs/adr/** — Architecture Decision Records are frozen history.
//   - test/fixtures/campaign/** — committed records of real sessions (the
//     #856 precedent: historical audit artifacts are excluded from prompt
//     scans, never falsified to pass them).
//   - packages/schema/test/fixtures/** — schema validation data, not teaching.
//   - .ts/.mjs/.sh + .github/** + overlays — code, not doc.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..");
const EXT = join(REPO, "packages", "extension");

/** Recursively collect files matching a suffix set under a dir. */
function walk(dir: string, suffixes: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p, suffixes);
      return suffixes.some((s) => e.name.endsWith(s)) ? [p] : [];
    });
}

const MD = [".md"];
const DOCISH = [".md", ".jl", ".toml"];

/** The doc surface: repo docs + the extension's shipped agent-taught content. */
function docSurface(): string[] {
  const files = [
    // repo-root docs
    join(REPO, "AGENTS.md"),
    join(REPO, "CONTRIBUTING.md"),
    join(REPO, "README.md"),
    // docs/ top level (NOT docs/adr — frozen history)
    ...walk(join(REPO, "docs"), MD).filter((p) => !p.includes(`${join("docs", "adr")}`)),
    // ops docs (hub-AGENTS.md is the staged server prompt's source of record)
    join(REPO, "ops", "README.md"),
    join(REPO, "ops", "server", "hub-AGENTS.md"),
    // extension package docs + shipped agent content
    ...readdirSync(EXT)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(EXT, n)),
    ...["skills", "agents", "scores", "templates", "exemplars", "packs", "modes"].flatMap((d) =>
      walk(join(EXT, d), DOCISH),
    ),
    // doc-shaped test fixtures (NOT campaign session records — history)
    ...walk(join(EXT, "test", "fixtures"), DOCISH).filter((p) => !p.includes(join("fixtures", "campaign"))),
    // golden compiled scores — they mirror the swept SCORE.md; the lint guards
    // a regenerated golden from re-importing a stale command.
    ...walk(join(EXT, "test", "scores", "golden"), MD),
  ];
  return files.filter((p) => statSync(p).isFile());
}

/** `amico-run` that is neither the package spec nor a folder-path segment. */
const BARE_BIN = /(?<!@amicode\/)(?<!packages\/)amico-run(?!\/)/;

/** Historical/provenance framing — the exemption the issue grants ("receipts,
 *  'superseded the amico-run X' framing, CHANGELOG"). */
const HISTORICAL = /(historical|supersed|retir|sunset|dissolut|formerly|deprecat|deleted|no longer|was (?:the|called|renamed))/i;

describe("#1668 — the doc surface teaches no amico-run-as-a-command references", () => {
  const files = docSurface();

  it("collects a real surface (a vacuous pass proves nothing)", () => {
    expect(files.length).toBeGreaterThan(60);
    // spot-check the load-bearing files are actually in it
    for (const must of [
      join(REPO, "AGENTS.md"),
      join(REPO, "CONTRIBUTING.md"),
      join(REPO, "ops", "server", "hub-AGENTS.md"),
      join(EXT, "AGENTS.md"),
      join(EXT, "CONTRACT.md"),
      join(EXT, "scores", "pulse-designer", "SCORE.md"),
      join(EXT, "scores", "pulse-designer", "templates", "solve.jl"),
      join(EXT, "test", "scores", "golden", "compile-score.md"),
    ]) {
      expect(files).toContain(must);
    }
  });

  it("no doc reference to amico-run survives the rule set (package spec / folder path / historical only)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!BARE_BIN.test(line)) return;
        if (HISTORICAL.test(line)) return; // provenance framing is exempt
        violations.push(`${f.replace(REPO + "/", "")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it("the exemption rule set actually exempts the sanctioned forms (not vacuous)", () => {
    // package spec + folder paths are legal mentions…
    expect("@amicode/amico-run").not.toMatch(BARE_BIN);
    expect("pnpm --filter @amicode/amico-run build").not.toMatch(BARE_BIN);
    expect("packages/amico-run/launcher/").not.toMatch(BARE_BIN);
    expect("node packages/amico-run/dist/amico.js doctor").not.toMatch(BARE_BIN);
    expect("fixtures/bridge/…/packages/amico-run/scripts/validate.mjs").not.toMatch(BARE_BIN);
    // …historical framing is exempt…
    expect("the amico-run bin was deleted in #1667").toMatch(BARE_BIN);
    expect("the amico-run bin was deleted in #1667").toMatch(HISTORICAL);
    expect("this doc superseded the amico-run CLI").toMatch(HISTORICAL);
    // …and a taught command is a violation.
    expect("run `amico-run --spec solvespec.json`").toMatch(BARE_BIN);
    expect("run `amico-run --spec solvespec.json`").not.toMatch(HISTORICAL);
  });
});
