// The claims registry core (amicode #1681, brain flywheel slice 2): the ONE
// type namespace's machinery — the memory-card → claim projection, the claim
// note rendering, and the registry lint. Hermetic suite over committed
// fixtures (the pack.toml fixture discipline: the fixture of record IS the
// contract; a shape change must fail here).
//
// The fixture card mirrors the REAL typed memory cards in the personal vault
// (amicode/memory/: name / description / type frontmatter + prose body —
// verified against the live cards 2026-10-02). The slow tier
// (test/slow/claims_live.test.ts) runs the same projection against a real card.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateClaim, type ClaimType } from "@amicode/schema";

import {
  parseMemoryCard,
  parseClaimNote,
  projectMemoryCard,
  renderClaimNote,
  MEMORY_CARD_TYPES,
  MEMORY_CARD_TO_CLAIM_TYPE,
  claimFileBasename,
  memoryCardPointer,
} from "../src/claims.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const CARD_FILE = join(FIXTURES, "memory", "project_two_qubit_challenge.md");
const CARD_REL = "project_two_qubit_challenge.md";

const PROJECTED_AT = "2026-10-02T12:00:00.000Z";

describe("the memory-card → claim projection (#1681, AC 3)", () => {
  it("projects the fixture card: every contract field lands mechanically, provenance intact", () => {
    const card = parseMemoryCard(readFileSync(CARD_FILE, "utf8"));
    const claim = projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT });

    // the mechanical projection, field by field
    expect(claim.type).toBe("insight"); // the project-card map
    expect(claim.statement).toBe("Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates");
    expect(claim.status).toBe("unverified"); // the lifecycle start — machinery stamps, never the projection
    expect(claim.confidence).toBe("medium"); // a hand-curated card carries no calibration — the honest middle
    expect(claim.evidence).toEqual(["memory-card/project_two_qubit_challenge.md"]); // the provenance pointer
    expect(claim.applied).toBe(0);
    expect(claim.last_applied).toBe(null);
    expect(claim.scope).toBe("personal"); // the cards' home; promotion is slice 6's copy-never-move
    expect(claim.tags).toEqual(["memory", "two-qubit"]); // the card's tags, verbatim
    expect(claim.history).toEqual([
      {
        date: PROJECTED_AT,
        event: "projected",
        note: `projected from memory card ${CARD_REL} (card type: project) by amico claims project — the #1681 mechanical migration of the memory namespace into claims`,
      },
    ]);
  });

  it("the projected claim passes the ONE schema — the projection emits contract objects, never a parallel shape", () => {
    const card = parseMemoryCard(readFileSync(CARD_FILE, "utf8"));
    const claim = projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT });
    expect(validateClaim(claim)).toEqual({ ok: true, errors: [] });
  });

  it("renders a claim note whose frontmatter is EXACTLY the claim object and whose body preserves the card verbatim", () => {
    const raw = readFileSync(CARD_FILE, "utf8");
    const card = parseMemoryCard(raw);
    const claim = projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT });
    const note = renderClaimNote(claim, card, CARD_REL);

    // frontmatter = the claim object, exactly (parse it back through the real
    // seam and validate against the ONE contract)
    const parsed = parseClaimNote(note);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(validateClaim(parsed.claim)).toEqual({ ok: true, errors: [] });

    // all card fields preserved: every frontmatter field of the card appears verbatim
    for (const line of ["name: two-qubit-gate-challenge", "type: project", "date: 2026-07-13", "status: active", "tags: [memory, two-qubit]"]) {
      expect(note).toContain(line);
    }
    // the card's prose survives verbatim (machinery never edits prose)
    expect(note).toContain("The Jul 3–13 campaign revealed a sharp difficulty cliff");
    expect(note).toContain("Consider breaking into sub-problems.");
    // provenance intact: the pointer + the original card path are named
    expect(note).toContain(memoryCardPointer(CARD_REL));
    expect(note).toContain("amicode/memory/project_two_qubit_challenge.md");
  });

  it("deterministic: same card + same instant → identical bytes (re-projection overwrites, never duplicates)", () => {
    const card = parseMemoryCard(readFileSync(CARD_FILE, "utf8"));
    const a = renderClaimNote(projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT }), card, CARD_REL);
    const b = renderClaimNote(projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT }), card, CARD_REL);
    expect(a).toBe(b);
    // and the claim file name is the card's — idempotent addressing
    expect(claimFileBasename("/vault/amicode/memory/project_two_qubit_challenge.md")).toBe("project_two_qubit_challenge.md");
  });

  it("maps every memory namespace type mechanically (the collision dissolved) and refuses unknown card types", () => {
    expect([...MEMORY_CARD_TYPES].sort()).toEqual(["feedback", "insight", "project", "reference"]);
    // the mechanical map — the fixed default; --type overrides per card
    expect(MEMORY_CARD_TO_CLAIM_TYPE.insight).toBe("insight");
    expect(MEMORY_CARD_TO_CLAIM_TYPE.feedback).toBe("best-practice");
    expect(MEMORY_CARD_TO_CLAIM_TYPE.project).toBe("insight");
    expect(MEMORY_CARD_TO_CLAIM_TYPE.reference).toBe("insight");

    const bad = parseMemoryCard("---\nname: x\ndescription: y\ntype: rant\n---\n\nbody\n");
    expect(() => projectMemoryCard(bad, { cardRel: "x.md", projectedAt: PROJECTED_AT })).toThrow(/unknown memory-card type/);
  });

  it("accepts an explicit type override and refuses a description-less card (never a guessed statement)", () => {
    const card = parseMemoryCard(readFileSync(CARD_FILE, "utf8"));
    const overridden = projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT, claimType: "hazard" as ClaimType });
    expect(overridden.type).toBe("hazard");
    expect(validateClaim(overridden).ok).toBe(true);

    const bare = parseMemoryCard("---\nname: x\ntype: project\n---\n\nbody\n");
    expect(() => projectMemoryCard(bare, { cardRel: "x.md", projectedAt: PROJECTED_AT })).toThrow(/description/);
  });
});
