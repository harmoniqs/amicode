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
// Containment source (#807, spec-20260905-063000 D2): the IN-REPO CANONICAL
// copy at skills/director-core/SKILL.md — what the vsix ships and these tests
// pin. The committed fixture copy is retired (the canonical copy IS in the
// repo). The live armonissima team mount is the engine-neutral RECORD: when
// present, its rule body must agree with the canonical's (rule-body parity,
// below) — full byte-identity is retired with the precedence flip: canonical
// wins at equal revision; the vault copy is a record, not the shipper.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLedgerDiscoveryRegion, generateLedgerDiscoveryRegion } from "@amicode/schema";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..");
const AGENTS_DIR = path.join(EXT, "agents");
// The in-repo canonical director-core skill (#807) — ships in the vsix; the
// parity pins below hold against IT, not a fixture.
const CANONICAL_SKILL = path.join(EXT, "skills", "director-core", "SKILL.md");

// The live armonissima team mount (the engine-neutral record); absent on
// machines without the mount.
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

const fixtureSkill = readFileSync(CANONICAL_SKILL, "utf8");
const canonicalSkill = fixtureSkill;

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

  it("the discovery rule sits inside the delimited, generator-stamped generated region (AC8, #804)", () => {
    // the region is emitted from the registry (one generator, one canonical
    // body) — the delimited form carries the generator's version stamp
    // inside the artifact, and the hand-edit ban is enforced by the shared
    // validator's regenerate-and-compare (mode_registry.test.ts)
    for (const name of CARDS) {
      const text = cardText(name);
      const c = classifyLedgerDiscoveryRegion(text);
      expect(c.status, `${name}: ${c.detail}`).toBe("ok");
      // the region lives INSIDE the director spine (the spine stays the
      // parity-checked carrier; the generated region rides within it)
      expect(spineOf(text).spine).toContain(generateLedgerDiscoveryRegion());
    }
  });

  it("the in-repo canonical director-core skill carries the SAME delimited, generator-stamped generated region — parity extends to the skill (AC8 deferred leg, #807)", () => {
    // the deferred AC8 leg from PR #810's review: the skill's
    // ledger-discovery-rule region is a delimited, generator-stamped
    // generated region (the registry's generator emits it), and the parity
    // checks extend to it — card ≡ skill ≡ registry.
    const c = classifyLedgerDiscoveryRegion(canonicalSkill);
    expect(c.status, `canonical skill: ${c.detail}`).toBe("ok");
    expect(canonicalSkill).toContain(generateLedgerDiscoveryRegion());
    // and the region's rule body is the one BOTH cards embed
    const rule = discoveryRuleFrom(canonicalSkill);
    for (const name of CARDS) {
      expect(spineOf(cardText(name)).spine).toContain(rule);
    }
  });

  it("the live armonissima record agrees on the RULE BODY when the mount is present (precedence flip, #807: the in-repo copy is canonical and ships; the vault is the engine-neutral record)", () => {
    if (!existsSync(LIVE_SKILL)) return; // mount absent: the canonical is the only copy
    const live = readFileSync(LIVE_SKILL, "utf8");
    // rule-body parity, NOT byte-identity: the canonical wraps the rule in
    // the delimited generated region (AC8); the vault record predates the
    // delimiters. What must hold is the RULE itself — one discovery rule
    // every mode resolves, engine-neutral record and shipped copy agreeing.
    expect(discoveryRuleFrom(live), "the vault record carries the same rule body").toBe(
      discoveryRuleFrom(canonicalSkill),
    );
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

  // review F2c pins — the structural invariants the scoped merge relies on:
  // exactly one Example brief caption, fenced ```text, INSIDE Method; the
  // Method subsections in pinned order; no ```text anywhere outside Method.
  it("pins: one ```text Example brief caption inside Method, none outside; pinned subsection order", () => {
    for (const name of WORKER_CARDS) {
      const text = workerText(name);
      const methodStart = text.indexOf("## Method");
      const methodEnd = (() => {
        const next = /^## /m.exec(text.slice(methodStart + 1));
        return next && next.index !== undefined ? methodStart + 1 + next.index : text.length;
      })();
      const method = text.slice(methodStart, methodEnd);
      const outside = text.slice(0, methodStart) + text.slice(methodEnd);
      // exactly one caption, inside Method
      expect((text.match(/^Example brief/gm) ?? []).length, `${name}: one Example brief caption`).toBe(1);
      expect(method).toMatch(/^Example brief/m);
      // its fence is ```text, and no ```text fence exists outside Method
      // (the merge fence search is scoped to Method — this pin keeps the
      // scope sound against card edits)
      expect(method).toContain("```text");
      expect(outside, `${name}: no text fence outside Method`).not.toContain("```text");
      // pinned subsection order within Method
      const order = ["Default procedure", "Model routing, default:", "Iteration budget, default:", "Example brief"];
      const positions = order.map((anchor) => method.search(new RegExp(`^${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m")));
      positions.forEach((p, k) => expect(p, `${name}: ${order[k]} present`).toBeGreaterThan(-1));
      for (let k = 1; k < positions.length; k++)
        expect(positions[k]!, `${name}: ${order[k]} after ${order[k - 1]}`).toBeGreaterThan(positions[k - 1]!);
    }
  });
});
