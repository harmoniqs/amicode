/**
 * Naming records (#500) — the spec's `naming_record_complete` criterion,
 * amicode side.
 *
 * Spec: spec-20260822-063957-auto-rd-two-modes.md (Naming table +
 * Measurement Protocol). Six terms are locked there; this suite pins their
 * amicode-side record: the glossary entries in the repo-root CONTEXT.md and
 * the committed blocklist fixture (proprietary strings + banned names).
 *
 * Matching rule (per the spec): a term's definition line must CONTAIN the
 * same head phrase as the spec's naming table — the first noun phrase after
 * the term. String containment, case-insensitive (sentence-initial
 * capitalization only); no semantic judgment anywhere in this file.
 * amicode's glossary is canonical on divergence; Avoid lines are required
 * in amicode's glossary only.
 *
 * SCOPE: the amico CONTEXT.md companion lines are a cross-repo PR
 * (harmoniqs/amicissimo) owned by parent #497 — this slice tests the
 * amicode-side records only. The dual-glossary (amicode ↔ amico) half of
 * `naming_record_complete` lands with that companion PR, not here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// test/ → packages/extension/ → packages/ → repo root
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CONTEXT_PATH = join(REPO_ROOT, "CONTEXT.md");
const BLOCKLIST_PATH = join(__dirname, "..", "protocol-blocklist.json");

const CONTEXT = readFileSync(CONTEXT_PATH, "utf8");

// The spec's naming table, locked verbatim. `head` = the first noun phrase
// after the term, exactly as the table writes it.
const LOCKED_TERMS: ReadonlyArray<{ term: string; head: string }> = [
  { term: "director", head: "the role that leads any autonomous loop" },
  { term: "autoresearch", head: "the research mode" },
  { term: "autodev", head: "the development mode" },
  { term: "campaign", head: "one bounded run of either autonomous mode" },
  { term: "gate pack", head: "the typed set of gates + phase templates" },
  { term: "mode", head: "one of the three director postures" },
];

// D4's proper-noun blocklist, and the banned-names table the spec homes in
// the same committed fixture.
const PROPRIETARY_STRINGS = ["telaio", "Piccolissimo", "Altissimo", "harmoniqs", "spartito"];
const BANNED_NAMES = ["conductor", "autobuild"];

interface GlossaryEntry {
  /** the definition line (first non-empty line after the **Term**: marker) */
  definition: string;
  /** the _Avoid_: line, when the entry carries one */
  avoid: string | null;
  /** the whole entry block (marker + definition + avoid) */
  block: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract one glossary entry's block from CONTEXT.md, or null if absent. */
function glossaryEntry(term: string): GlossaryEntry | null {
  const re = new RegExp(`\\*\\*${escapeRegExp(term)}\\*\\*:`, "i");
  const match = re.exec(CONTEXT);
  if (!match) return null;
  const rest = CONTEXT.slice(match.index);
  // The entry ends at the next bolded term, the next heading, or EOF.
  const tail = rest.slice(1);
  const endRel = tail.search(/\n(\*\*|#{2,3} )/);
  const block = endRel === -1 ? rest : rest.slice(0, endRel + 1);
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const definition = lines[1] ?? "";
  const avoid = lines.find((l) => l.toLowerCase().startsWith("_avoid_:")) ?? null;
  return { definition, avoid, block };
}

describe("naming records — six locked terms in the amicode glossary", () => {
  const languageIdx = CONTEXT.indexOf("## Language");

  it("every locked term has a glossary entry under ## Language, with a definition line", () => {
    expect(languageIdx, "CONTEXT.md carries a ## Language section").toBeGreaterThan(-1);
    for (const { term } of LOCKED_TERMS) {
      const entry = glossaryEntry(term);
      expect(entry, `glossary entry for "${term}"`).not.toBeNull();
      if (!entry) continue;
      expect(entry.definition.length, `definition line for "${term}"`).toBeGreaterThan(0);
      const markerIdx = CONTEXT.toLowerCase().indexOf(`**${term.toLowerCase()}**:`);
      expect(markerIdx, `"${term}" lives under ## Language`).toBeGreaterThan(languageIdx);
    }
  });

  it("each definition line contains the spec's head phrase (string containment, no semantics)", () => {
    for (const { term, head } of LOCKED_TERMS) {
      const entry = glossaryEntry(term);
      expect(entry, `glossary entry for "${term}"`).not.toBeNull();
      if (!entry) continue;
      expect(entry.definition.toLowerCase(), `head phrase for "${term}"`).toContain(head);
    }
  });

  it("director and autodev carry Avoid lines recording the banned names", () => {
    const director = glossaryEntry("director");
    const autodev = glossaryEntry("autodev");
    expect(director, "director entry").not.toBeNull();
    expect(autodev, "autodev entry").not.toBeNull();
    expect((director?.avoid ?? "").toLowerCase(), "director avoids 'conductor'").toContain(
      "conductor",
    );
    expect((autodev?.avoid ?? "").toLowerCase(), "autodev avoids 'autobuild'").toContain(
      "autobuild",
    );
  });

  it("mode records copilot as the zeroth, packless posture", () => {
    const mode = glossaryEntry("mode");
    expect(mode, "mode entry").not.toBeNull();
    const block = (mode?.block ?? "").toLowerCase();
    expect(block).toContain("copilot");
    expect(block).toContain("zeroth");
    expect(block).toContain("packless");
  });

  it("the six entries carry no blocklisted proprietary string (protocol layer: generic phrasing)", () => {
    for (const { term } of LOCKED_TERMS) {
      const entry = glossaryEntry(term);
      expect(entry, `glossary entry for "${term}"`).not.toBeNull();
      if (!entry) continue;
      for (const s of PROPRIETARY_STRINGS) {
        expect(
          entry.block.toLowerCase(),
          `"${term}" entry must not mention "${s}"`,
        ).not.toContain(s.toLowerCase());
      }
    }
  });
});

describe("blocklist fixture (proprietary strings + banned names)", () => {
  it("parses and carries exactly the two tables with the specified entries", () => {
    const raw = readFileSync(BLOCKLIST_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed, "fixture is a JSON object").toBeTypeOf("object");
    const tables = parsed as Record<string, unknown>;
    expect(Object.keys(tables).sort()).toEqual(["banned_names", "proprietary_strings"]);
    expect(Array.isArray(tables.proprietary_strings), "proprietary_strings is a table").toBe(true);
    expect(Array.isArray(tables.banned_names), "banned_names is a table").toBe(true);
    const prop = (tables.proprietary_strings as unknown[]).map(String).sort();
    const banned = (tables.banned_names as unknown[]).map(String).sort();
    expect(prop).toEqual([...PROPRIETARY_STRINGS].sort());
    expect(banned).toEqual([...BANNED_NAMES].sort());
  });

  it("is canonical JSON (deterministic formatting, stable under round-trip)", () => {
    const raw = readFileSync(BLOCKLIST_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).toBe(JSON.stringify(parsed, null, 2) + "\n");
  });
});
