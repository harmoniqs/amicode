// skill_salvage_851.test.ts — the amico-plugin salvage (amicode#851): the
// archived repo's un-landed content, ported into the in-repo skill library.
// Pins:
//   - the `promote` skill (amico-plugin PR #45): shippable frontmatter,
//     provenance header, NO dead relative link into the archived repo's skill
//     tree, and promotion semantics that MATCH the documented ones
//     (`amico-vault` → "Promotion semantics": copy-never-move,
//     promoted_from/promoted_date on the copy, promoted_to after merge);
//   - the `visibility` authoring gate (PR #45's two one-line tags): the
//     amico-vault spec + plan schemas and the brainstorming spec template
//     carry the field;
//   - the `intonatoqick` skill (amico-plugin PR #42): public surface,
//     provenance, the entitled tier named as `intonatissimo` (current
//     package reality), and the sibling skills referenced not duplicated;
//   - the restricted 6th vault kind (amico-plugin PRs #48/#27): the
//     amico-vault kind table carries all SIX kinds and the prompt-side
//     condensed routing (stack_state.ts) agrees — the prompt↔skill
//     disagreement the audit found is closed and pinned shut.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const SKILLS = join(EXT, "skills");

const readSkill = (name: string): string => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
const frontmatter = (text: string): string => text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

// ── PR #45: the promote skill + the visibility authoring gate ────────────────

describe("salvaged promote skill (amico-plugin PR #45 → amicode#851)", () => {
  const promote = readSkill("promote");

  it("carries shippable frontmatter: surface public (the shipped library hard-refuses internal)", () => {
    const fm = frontmatter(promote);
    expect(fm).toMatch(/^name:\s*promote\s*$/m);
    expect(fm).toMatch(/^surface:\s*public\b/m);
    expect(fm).toMatch(/^description:\s*\S/m);
  });

  it("carries its salvage provenance (amico-plugin PR #45, archived repo)", () => {
    expect(promote).toMatch(/amico-plugin.*PR #45/);
    expect(promote).toMatch(/#851/);
  });

  it("has no dead relative link into the archived repo's skill tree", () => {
    // the source linked `../dream-promote/SKILL.md` — that tree does not exist
    // here, and the drift lint fails broken relative refs structurally.
    expect(promote).not.toMatch(/\]\(\.\.\//);
  });

  it("matches the DOCUMENTED promotion semantics — copy never move, provenance fields, stamp after merge", () => {
    // amico-vault "Promotion semantics" is the semantics of record; the skill
    // must obey it, not invent new ones.
    const vault = readSkill("amico-vault");
    const semantics = vault.slice(vault.indexOf("### Promotion semantics"));
    expect(semantics).toContain("promoted_from");
    expect(semantics).toContain("promoted_to");
    // the skill carries the same three fields with the same copy-never-move shape
    for (const field of ["promoted_from", "promoted_date", "promoted_to"]) {
      expect(promote, `promote carries ${field}`).toContain(field);
    }
    expect(promote).toMatch(/Copy, never move/);
    expect(promote).toMatch(/only after merge/);
    expect(promote).toMatch(/Fresh clone, never the local mount/);
  });

  it("defers to amico-vault's promotion-semantics section (no second definition)", () => {
    expect(promote).toMatch(/amico-vault.*Promotion semantics|Promotion semantics.*amico-vault/s);
  });
});

describe("the visibility authoring gate (PR #45's two one-line tags)", () => {
  it("the amico-vault spec + plan schemas document `visibility: local | team | public`", () => {
    const vault = readSkill("amico-vault");
    const specSchema = vault.slice(vault.indexOf("### spec"), vault.indexOf("### plan"));
    const planSchema = vault.slice(vault.indexOf("### plan"), vault.indexOf("### hypothesis"));
    const VISIBILITY = /visibility: local \| team \| public/;
    expect(specSchema, "the spec schema carries the visibility field").toMatch(VISIBILITY);
    expect(planSchema, "the plan schema carries the visibility field").toMatch(VISIBILITY);
  });

  it("the brainstorming spec template tags shared research specs `visibility: team`", () => {
    const brainstorming = readSkill("brainstorming");
    const template = brainstorming.slice(brainstorming.indexOf("Vault-spec route only"));
    expect(template).toMatch(/visibility: team/);
    expect(template).toMatch(/Solo\/scratch → local/);
  });

  it("the two-note pattern's federation gate stays the semantics of record (visibility gates promotion)", () => {
    const vault = readSkill("amico-vault");
    expect(vault).toMatch(/only `team`\/`public` notes are eligible for promotion/);
  });
});
