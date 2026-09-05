// workflow_skills_public.test.ts — the public workflow skill surface (#807,
// spec-20260905-063000 D2): the five dev-workflow skills + the NEW `autodev`
// mode-protocol skill live as in-repo canonical copies under
// packages/extension/skills/ with `surface: public`. This file pins:
//
//   - the `autodev` skill's structure, mirroring `autoresearch` (entry
//     points, loop bound to the dev pack's phases/gates, ledger discipline,
//     honest degradation naming what is missing, handoff section with the
//     mid-session switch marked PENDING-D5 — parameterized on D5 state per
//     the spec: the assertion flips when slice 5 lands);
//   - `develop` cross-references `autodev` and defers to it as the mode
//     binding;
//   - the #809 content lens, mechanically: none of the six skills carries a
//     blocklisted proprietary string (the naming fixture of record) or an
//     internal-machine path shape (the per-line usage-vs-internals boundary
//     test's regression guard — the pass itself is recorded in the PR notes).
// The revision-selection matrix lives in package_skills.test.ts; the
// director-core generated-region parity in mode_cards/mode_registry tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const SKILLS = join(EXT, "skills");
const MODES = join(EXT, "modes");

const SIX = [
  "director-core",
  "develop",
  "implement-issue",
  "write-an-issue",
  "break-into-subissues",
  "autodev",
] as const;

const skillText = (name: string): string =>
  readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

// ── the autodev skill: structure mirroring autoresearch (D2) ──────────────────

describe("the autodev mode-protocol skill (#807, D2 — mirrors autoresearch)", () => {
  const autodev = skillText("autodev");
  const autoresearch = skillText("autoresearch");

  it("carries the three entry points (the agent card, the skill itself, kickoff-prompt lines)", () => {
    expect(autodev).toMatch(/## Autodev|entry points/i);
    expect(autodev).toMatch(/Entry points/i);
    // mirroring autoresearch's entry-point shape: card, skill, kickoff lines
    expect(autodev).toMatch(/agent card/i);
    expect(autodev).toMatch(/kickoff/i);
    expect(autoresearch).toMatch(/Entry points/i); // the mirror's shape — guard against drifting the mirror
  });

  it("binds the loop to the dev pack's phases and gates (read from the landed registry's bundle, not prose)", () => {
    const pack = readFileSync(join(MODES, "autodev", "pack.toml"), "utf8");
    for (const phase of ["decompose", "implement", "integrate"]) {
      expect(pack, `the shipped pack carries the ${phase} phase`).toMatch(new RegExp(`^name = "${phase}"`, "m"));
      expect(autodev, `the skill binds the ${phase} phase`).toContain(phase);
    }
    for (const gate of ["dev-gate", "blocked-by-clearance", "tdd-red-green", "draft-pr-lifecycle", "review"]) {
      expect(pack, `the shipped pack carries the ${gate} gate`).toContain(gate);
      expect(autodev, `the skill binds the ${gate} gate`).toContain(gate);
    }
    // and the mode's manifest declares the skill among its protocol skills
    const manifest = readFileSync(join(MODES, "autodev", "mode.toml"), "utf8");
    expect(manifest).toMatch(/"autodev"/);
  });

  it("carries ledger discipline anchored on the ledger discovery rule the cards carry", () => {
    expect(autodev).toMatch(/## The ledger/);
    expect(autodev).toContain("sessions/session-<YYYYMMDD>-<slug>.md"); // the rule's path convention
    expect(autodev).toMatch(/re-read.*ledger.*disk|disk.*ledger/i); // re-read-first discipline
    expect(autodev).toContain("director-core"); // the canonical rule's owner
  });

  it("documents the handoff procedure BOTH directions, seeds named (D6: schema in D1, procedure here)", () => {
    expect(autodev).toMatch(/## Handoffs/);
    expect(autodev).toContain("issue"); // receives the issue seed (issue-seed schema)
    expect(autodev).toContain("hypothesis"); // emits the hypothesis seed
    // the pack's handoff target is autoresearch — the skill's emit matches it
    const pack = readFileSync(join(MODES, "autodev", "pack.toml"), "utf8");
    expect(pack).toMatch(/hypothesis_seed/);
    expect(pack).toMatch(/target = "autoresearch"/);
    expect(autodev).toMatch(/autoresearch/);
  });

  it("the handoff section marks the mid-session switch PENDING-D5 — parameterized: the assertion flips when slice 5 lands", () => {
    // D5 state: the fork's mid-session posture switcher has NOT landed
    // (slice 5, opencode#297). When it lands, this constant flips to true,
    // the mark leaves the skill (a revision bump), and this assertion then
    // DEMANDS the mark's absence — the parameterized flip, never a deleted test.
    const D5_MID_SESSION_SWITCH_LANDED = false;
    const handoff = autodev.slice(autodev.indexOf("## Handoffs"));
    const markPresent = handoff.includes("PENDING-D5");
    expect(markPresent).toBe(!D5_MID_SESSION_SWITCH_LANDED);
    // the safe path is named while pending (spawn/open on the seed), and the
    // ledger-survives claim holds either way
    expect(handoff).toMatch(/spawn|open/i);
    expect(handoff).toMatch(/ledger/);
  });

  it("carries honest degradation text naming what is missing on a BUILD-with-missing-pieces (H3: degraded_staging_is_honest, the skill half)", () => {
    expect(autodev).toMatch(/## Honest degradation/);
    const section = autodev.slice(autodev.indexOf("## Honest degradation"));
    // names the ABSENT SKILL COPIES case: zero dev skills staged + say so
    expect(section).toMatch(/Absent skill copies|skill index/i);
    for (const name of ["director-core", "develop", "implement-issue", "write-an-issue", "break-into-subissues"]) {
      expect(section).toContain(name);
    }
    // names the ABSENT BUNDLE PARTS case (card / gate pack not staged)
    expect(section).toMatch(/Absent bundle parts/i);
    expect(section).toMatch(/gate pack|modes\/autodev/i);
    expect(section).toMatch(/never pretend|do not fabricate|never a silent/i);
    // and the absent dispatch surface (the walk's own fallback)
    expect(section).toMatch(/Absent dispatch surface/i);
  });
});

describe("develop cross-references autodev and defers to it as the mode binding (#807, D2)", () => {
  it("develop names autodev as the mode binding and points posture questions at it", () => {
    const develop = skillText("develop");
    expect(develop).toMatch(/Mode binding/i);
    expect(develop).toMatch(/defer.*autodev|autodev.*defer/i);
    expect(develop).toContain("**autodev**");
  });
});

// ── the #809 content lens, mechanically (the pass is recorded in PR notes; ────
//    this is its regression guard — per-line usage-vs-internals boundary)

describe("content lens — the public workflow skills carry no proprietary or internal-machine content (#809 fold)", () => {
  // The naming fixture of record (protocol-blocklist.json — same tables
  // naming_records.test.ts pins): user-facing product names stay
  // open-protocol on the public surface.
  const BLOCKLIST = JSON.parse(readFileSync(join(EXT, "protocol-blocklist.json"), "utf8")) as {
    proprietary_strings: string[];
    banned_names: string[];
  };
  const PROPRIETARY_STRINGS = BLOCKLIST.proprietary_strings;
  const BANNED_NAMES = BLOCKLIST.banned_names;

  it("guards: the fixtures of record carry the real lists (an empty blocklist would make the lens vacuous)", () => {
    expect(PROPRIETARY_STRINGS.length).toBeGreaterThanOrEqual(5);
    expect(BANNED_NAMES.length).toBeGreaterThanOrEqual(2);
  });

  it("none of the six public skills carries a blocklisted proprietary string or banned name", () => {
    for (const name of SIX) {
      const text = skillText(name).toLowerCase();
      for (const s of [...PROPRIETARY_STRINGS, ...BANNED_NAMES]) {
        expect(
          text.includes(s.toLowerCase()),
          `${name} must not contain "${s}" on the public surface`,
        ).toBe(false);
      }
    }
  });

  it("none of the six carries an internal-machine path shape (mount paths, fleet hosts, private repo paths)", () => {
    const INTERNAL_PATH_SHAPES = [
      "/home/", // absolute home paths (fleet hosts, user trees)
      "~/armonia", // the workspace's internal mount layout
      ".amico/vaults", // vault mount paths
      "armonissima", // the private team mount's name
      "repos/amico", // the private amico repo layout
    ];
    for (const name of SIX) {
      const text = skillText(name).toLowerCase();
      for (const shape of INTERNAL_PATH_SHAPES) {
        expect(
          text.includes(shape.toLowerCase()),
          `${name} must not carry the internal path shape "${shape}"`,
        ).toBe(false);
      }
    }
  });

  it("no 'how to modify/extend' recipe or roadmap pointer survives the lens (authoring the skills goes through the repo, not the prose)", () => {
    const RECIPE_SHAPES = [
      /how to (modify|extend|edit) (this|the) skill/i,
      /migrating per (issue|amico)#\d+/i, // internal roadmap pointers
      /in-flight (migration|redesign)/i,
    ];
    for (const name of SIX) {
      const text = skillText(name);
      for (const re of RECIPE_SHAPES) {
        expect(re.test(text), `${name} must not carry recipe/roadmap prose (${re})`).toBe(false);
      }
    }
  });
});
