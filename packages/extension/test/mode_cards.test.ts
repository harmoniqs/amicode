// Mode cards (#501) — spec-20260822-063957 `mode_card_spine_parity` + the
// card halves of `oss_degradation_clean`.
//
// One director, provably: both mode cards carry the SAME director spine
// between literal DIRECTOR-SPINE v1 markers (one pair per card), the spine
// clears a content floor (the loop verbs + core-clause keywords, whole-word,
// case-insensitive, order-free, each in a real sentence of ≥ 8 words), and
// the ledger discovery rule inside the spine appears VERBATIM in the
// director-core skill (correctness by containment, D1). The blocklist grep
// keeps the cards' vocabulary open-protocol.
//
// Hermetic containment source: test/fixtures/director-core/SKILL.md is the
// committed fixture copy. The RUNTIME canonical source is the live
// armonissima team mount checkout (skills/director-core/SKILL.md) — when
// that mount is present, the fixture must be byte-identical to it, so the
// committed copy cannot silently drift from the canonical one either.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..");
const AGENTS_DIR = path.join(EXT, "agents");
const FIXTURE_SKILL = path.join(HERE, "fixtures", "director-core", "SKILL.md");

// The live armonissima team mount (read-only runtime source of the canonical
// director core); absent on machines without the mount.
const LIVE_SKILL = path.join(
  process.env.HOME ?? "",
  ".amico",
  "vaults",
  "armonissima",
  "skills",
  "director-core",
  "SKILL.md",
);

const CARDS = ["autodev.md", "autoresearch.md"] as const;
type CardName = (typeof CARDS)[number];

const SPINE_START = "<!-- DIRECTOR-SPINE v1 START -->";
const SPINE_END = "<!-- DIRECTOR-SPINE v1 END -->";

// D4's proper-noun blocklist, loaded from the fixture of record
// (packages/extension/protocol-blocklist.json — committed by the naming
// slice; kept the single in-repo home of the strings). No blocklisted
// string is spelled out in this file.
const BLOCKLIST_PATH = path.join(EXT, "protocol-blocklist.json");
const PROPRIETARY_STRINGS: string[] = (
  JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8")) as {
    proprietary_strings: string[];
  }
).proprietary_strings;
const BANNED_NAMES: string[] = (
  JSON.parse(readFileSync(BLOCKLIST_PATH, "utf8")) as {
    banned_names: string[];
  }
).banned_names;

// The five loop verbs + four core-clause keywords (Measurement Protocol).
const LOOP_VERBS = ["plan", "dispatch", "gate", "analyze", "record"] as const;
const CORE_CLAUSES = ["ledger", "cast", "compaction", "anti-gaming"] as const;
const KEYWORDS = [...LOOP_VERBS, ...CORE_CLAUSES] as const;

const cardText = (name: CardName): string =>
  readFileSync(path.join(AGENTS_DIR, name), "utf8");

const fixtureSkill = readFileSync(FIXTURE_SKILL, "utf8");

/** Extract the spine between the marker pair; counts pairs for the one-pair rule. */
function spineOf(text: string): { spine: string; pairs: number } {
  const starts = countOccurrences(text, SPINE_START);
  const ends = countOccurrences(text, SPINE_END);
  const first = text.indexOf(SPINE_START);
  const last = text.indexOf(SPINE_END);
  if (first === -1 || last === -1 || last < first) {
    return { spine: "", pairs: Math.max(starts, ends) };
  }
  return {
    spine: text.slice(first + SPINE_START.length, last),
    pairs: Math.min(starts, ends),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Whole-word, case-insensitive regex match. */
function hasWholeWord(text: string, word: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9-])${word}(?:s|d|ed|ing)?([^A-Za-z0-9-]|$)`, "i");
  return re.test(text);
}

/**
 * The sentence containing the first whole-word match of `word`, sentences
 * split on [.!?] boundaries. Returns "" when no match.
 */
function containingSentence(text: string, word: string): string {
  if (!hasWholeWord(text, word)) return "";
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.find((s) => hasWholeWord(s, word)) ?? "";
}

const wordCount = (sentence: string): number =>
  sentence.split(/\s+/).filter((w) => w.length > 0).length;

/** The ledger discovery rule's canonical fenced block, extracted from the skill. */
function discoveryRuleFrom(skill: string): string {
  const marker = "LEDGER DISCOVERY RULE v1";
  expect(skill.includes(marker), "skill carries the discovery-rule block").toBe(true);
  // The fenced ```text block that CONTAINS the marker (the opening fence
  // precedes it, so search fence pairs, not forward from the marker).
  const openFence = skill.lastIndexOf("```text", skill.indexOf(marker));
  const closeFence = skill.indexOf("```", openFence + "```text".length);
  expect(openFence, "discovery rule sits in a fenced text block").toBeGreaterThan(-1);
  expect(closeFence, "the discovery-rule fence closes").toBeGreaterThan(-1);
  return skill.slice(openFence, closeFence + 3);
}

describe("mode cards — marker pairs", () => {
  for (const name of CARDS) {
    it(`${name}: carries exactly one DIRECTOR-SPINE v1 marker pair`, () => {
      const { pairs } = spineOf(cardText(name));
      expect(pairs, `${name} must carry exactly one marker pair`).toBe(1);
    });
  }
});

describe("mode cards — spine parity (byte-identity)", () => {
  const spines = CARDS.map((name) => spineOf(cardText(name)).spine);

  it("the two spines are byte-identical", () => {
    expect(spines[0], "autodev spine === autoresearch spine, byte for byte").toBe(
      spines[1],
    );
  });

  it("each spine is at least 200 bytes", () => {
    for (const [i, name] of CARDS.entries()) {
      expect(
        Buffer.byteLength(spines[i] ?? "", "utf8"),
        `${name} spine byte length`,
      ).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("mode cards — spine content floor", () => {
  const spine = spineOf(cardText("autodev.md")).spine; // parity ⇒ one check suffices

  it("carries all five loop verbs, each in a sentence of at least 8 words", () => {
    for (const verb of LOOP_VERBS) {
      expect(hasWholeWord(spine, verb), `spine contains "${verb}"`).toBe(true);
      const sentence = containingSentence(spine, verb);
      expect(wordCount(sentence), `"${verb}" lives in a real sentence`).toBeGreaterThanOrEqual(8);
    }
  });

  it("carries all four core-clause keywords, each in a sentence of at least 8 words", () => {
    for (const clause of CORE_CLAUSES) {
      expect(hasWholeWord(spine, clause), `spine contains "${clause}"`).toBe(true);
      const sentence = containingSentence(spine, clause);
      expect(wordCount(sentence), `"${clause}" lives in a real sentence`).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("mode cards — ledger discovery rule (correctness by containment)", () => {
  const spine = spineOf(cardText("autoresearch.md")).spine;

  it("the spine contains the canonical discovery-rule block verbatim", () => {
    const rule = discoveryRuleFrom(fixtureSkill);
    expect(spine).toContain(rule);
  });

  it("the committed fixture is the live armonissima director core when the mount is present", () => {
    if (!existsSync(LIVE_SKILL)) return; // mount absent: fixture is the hermetic source
    const live = readFileSync(LIVE_SKILL, "utf8");
    expect(fixtureSkill, "fixture === live canonical skill").toBe(live);
  });
});

describe("mode cards — frontmatter (boot-check fields)", () => {
  for (const name of CARDS) {
    it(`${name}: frontmatter carries description and mode`, () => {
      const text = cardText(name);
      expect(text.startsWith("---\n"), `${name} opens with YAML frontmatter`).toBe(true);
      const end = text.indexOf("\n---\n", 4);
      expect(end, `${name} frontmatter closes`).toBeGreaterThan(-1);
      const frontmatter = text.slice(4, end);
      expect(frontmatter, `${name} declares a description`).toMatch(/^description:\s*\S/m);
      expect(frontmatter, `${name} declares a mode`).toMatch(/^mode:\s*\S/m);
    });
  }
});

describe("mode cards — blocklist (open-protocol vocabulary)", () => {
  for (const name of CARDS) {
    it(`${name}: zero blocklisted proprietary strings`, () => {
      // Guard: the fixture of record carries the five spec'd strings — an
      // empty blocklist would make this test vacuously green.
      expect(PROPRIETARY_STRINGS.length).toBeGreaterThanOrEqual(5);
      const text = cardText(name);
      for (const s of PROPRIETARY_STRINGS) {
        expect(
          text.toLowerCase().includes(s.toLowerCase()),
          `${name} must not contain "${s}"`,
        ).toBe(false);
      }
    });
  }
});

// ── #761: worker base cards — contract floor + default-method-body floor ────
//
// The five worker cards (analyzer, experimenter, hypothesizer, implementer,
// librarian) are public base cards: complete products with no entitlement.
// The floor tests pin what the overlay architecture depends on — the frozen
// output contract, the four pinned sections, and a complete default for
// every method-class dimension an overlay tunes.
const WORKER_CARDS = [
  "analyzer.md",
  "experimenter.md",
  "hypothesizer.md",
  "implementer.md",
  "librarian.md",
] as const;
type WorkerCard = (typeof WORKER_CARDS)[number];

const workerText = (name: WorkerCard): string =>
  readFileSync(path.join(AGENTS_DIR, name), "utf8");

describe("worker cards — contract floor (one per card)", () => {
  for (const name of WORKER_CARDS) {
    it(`${name}: blocklist (banned names AND proprietary strings) + frozen output contract`, () => {
      // Guards: the fixtures of record carry the real lists — empty lists
      // would make the blocklist half of this floor vacuously green.
      expect(PROPRIETARY_STRINGS.length).toBeGreaterThanOrEqual(5);
      expect(BANNED_NAMES.length).toBeGreaterThanOrEqual(2);
      const text = workerText(name);
      for (const s of [...PROPRIETARY_STRINGS, ...BANNED_NAMES]) {
        expect(
          text.toLowerCase().includes(s.toLowerCase()),
          `${name} must not contain "${s}"`,
        ).toBe(false);
      }
      // the output contract is present and marked frozen — the interface an
      // overlay may never touch
      expect(text).toMatch(/^## Output contract$/m);
      expect(text).toMatch(/Frozen interface/i);
    });
  }
});

describe("worker cards — default-method-body floor (one per card)", () => {
  for (const name of WORKER_CARDS) {
    it(`${name}: four pinned sections + every method-class dimension defaulted`, () => {
      const text = workerText(name);
      // the four pinned sections, in order
      const sections = ["## Role", "## Inputs", "## Method", "## Output contract"];
      const idx = sections.map((s) => text.indexOf(s));
      idx.forEach((i, k) => expect(i, `${name} carries ${sections[k]}`).toBeGreaterThan(-1));
      for (let k = 1; k < idx.length; k++)
        expect(idx[k]!, `${name}: ${sections[k]} after ${sections[k - 1]}`).toBeGreaterThan(idx[k - 1]!);
      // method-class dimension coverage: the Method section carries a
      // complete default for every dimension an overlay may tune
      const method = text.slice(idx[2]!, idx[3]!);
      expect(method, `${name}: default procedure (the prompt body)`).toMatch(/^Default procedure/m);
      expect(method, `${name}: model routing default`).toMatch(/^Model routing, default: /m);
      expect(method, `${name}: iteration budget default`).toMatch(/^Iteration budget, default: /m);
      expect(method, `${name}: example brief`).toMatch(/^Example brief/m);
      expect(method, `${name}: example brief sits in a text fence`).toContain("```text");
    });
  }
});
