// role_cards_parity.test.ts — the parity half of the seed gate (slice 2 /
// D3, #806, AC3 + AC4, spec-20260905-063000 D3): the shipped role cards are
// the opencode bindings; the amicissimo vault's agent records are the
// engine-neutral contracts; THIS suite keeps the overlap coherent.
//
// The pin record (test/fixtures/vault-agents/pin.json) is REVISION-PINNED:
// it carries the amicissimo vault revision the parity baseline was taken at
// plus the per-definition digests AT that revision — provenance without
// content, self-contained on machines without the vault checkout. The
// nightly pin-behind-HEAD check (ops/role-parity, riding the doctor's fleet
// cadence on the vault-visible machine) re-checks the pin against the live
// amicissimo checkout and files a chore issue on drift (obligation O8).
//
// THE GATE, honored mechanically (never prose):
//   - COHERENT anchors (both texts agree) are pinned against the SHIPPED
//     CARD now. The fixture halves of those pins — and the full-definition
//     fixture publications themselves — are PENDING SIGNATURE (review B1,
//     PR #811): the vault definitions as committed fixtures failed the
//     amended content policy's per-line usage-vs-internals test (the
//     engineer def's src/ module tree, how-to-extend recipe, and internals
//     sections; the experimenter def's literal internal host paths), so
//     NOTHING from the vault definitions is published-verbatim or pinned
//     before Aaron's signature decides. The holds are named skips citing
//     the diff document — reversible at signature, never silent.
//   - FLAGGED content (the prepared human diff,
//     docs/seed-gate/role-cards-seed-diff.md) is pinned only after AARON
//     signs. Pre-signature those anchors are skips whose reasons name the
//     flag and cite the diff document. A two-directional guard keeps doc
//     and suite in lockstep: every suite flag appears in the doc, and
//     every doc flag key is carried by the suite (a flag on either side
//     alone fails the guard).
//   - The doc's signature status, the suite's SEED_GATE_SIGNED switch, and
//     the provenance record's amendment claim are COUPLED: an unsigned
//     tree cannot carry a signed amendment, and the switch never flips
//     alone (flip BOTH, in the same change, with the signature).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..");
const AGENTS_DIR = join(EXT, "agents");
const FIXTURES = join(HERE, "fixtures", "vault-agents");
const PIN_PATH = join(FIXTURES, "pin.json");
const DIFF_DOC = join(HERE, "..", "..", "..", "docs", "seed-gate", "role-cards-seed-diff.md");
const PROVENANCE_PATH = join(AGENTS_DIR, ".seed-provenance.json");

/** The seed gate's switch of record. Flip to true ONLY in the same change
 *  that lands Aaron's signature in docs/seed-gate/role-cards-seed-diff.md
 *  (the coupling test below fails otherwise — never flip it alone). */
const SEED_GATE_SIGNED = false;

interface PinEntry {
  role_card: string;
  vault_path: string;
  sha256: string;
  /** Present only when the full-definition fixture is PUBLISHED (the
   *  post-signature state); absent pre-signature (review B1). */
  fixture?: string;
}
interface PinRecord {
  record_version: number;
  vault_repo: string;
  vault_revision: string;
  /** "pending-signature" pre-signature (B1: no full-definition fixture is
   *  published); "published" once the signature lands and the fixtures
   *  return (at the re-authored revision, if the follow-up runs first). */
  fixture_publication: "published" | "pending-signature";
  pinned: PinEntry[];
  no_counterpart: Array<{ role_card: string; nearest_kin: string; reason: string }>;
}

const pin = JSON.parse(readFileSync(PIN_PATH, "utf8")) as PinRecord;
const cardText = (name: string): string => readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
const sha256 = (p: string): string =>
  "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");

// ── the revision-pinned record (AC3) ────────────────────────────────────────

describe("the parity pin record is revision-pinned (it carries the vault revision)", () => {
  it("pin.json carries a real amicissimo revision and both overlapping definitions", () => {
    expect(pin.record_version).toBe(2);
    expect(pin.vault_repo).toBe("harmoniqs/amicissimo");
    expect(pin.vault_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.pinned.map((p) => p.role_card).sort()).toEqual(["experimenter", "implementer"]);
  });

  it("the no-counterpart roles are RECORDED with reasons, never silently unpinned", () => {
    expect(pin.no_counterpart.map((n) => n.role_card).sort()).toEqual(["analyzer", "hypothesizer"]);
    for (const n of pin.no_counterpart) {
      expect(n.reason.length).toBeGreaterThan(20);
    }
  });
});

// ── B1 (review, PR #811): the fixture publications are held pending signature ─

describe("fixture publications held pending signature (review B1 — nothing published-verbatim pre-signature)", () => {
  it("the full-definition fixtures are ABSENT from the repo while the gate is unsigned (the B1 hold)", () => {
    expect(SEED_GATE_SIGNED).toBe(false); // this cell flips with the signature
    for (const p of pin.pinned) {
      if (p.fixture === undefined) continue;
      expect(existsSync(join(FIXTURES, p.fixture)), `${p.fixture} must not be published pre-signature`).toBe(false);
    }
    // and the record says so
    expect(pin.fixture_publication).toBe("pending-signature");
    // no pinned entry carries a committed fixture path while held
    for (const p of pin.pinned) {
      expect(p.fixture, `${p.role_card}: no committed fixture path pre-signature`).toBeUndefined();
    }
  });

  it.skip("PENDING SIGNATURE — fixture integrity: every published fixture byte-matches its recorded digest (fixture publication: engineer.md (full vault definition)) — see docs/seed-gate/role-cards-seed-diff.md", () => {
    for (const p of pin.pinned) {
      if (p.fixture === undefined) continue;
      expect(sha256(join(FIXTURES, p.fixture))).toBe(p.sha256);
    }
  });

  it.skip("PENDING SIGNATURE — fixture integrity: every published fixture byte-matches its recorded digest (fixture publication: experimenter.md (full vault definition)) — see docs/seed-gate/role-cards-seed-diff.md", () => {
    for (const p of pin.pinned) {
      if (p.fixture === undefined) continue;
      expect(sha256(join(FIXTURES, p.fixture))).toBe(p.sha256);
    }
  });
});

// ── the seed-gate record (AC4) + the coupling invariants (review A1) ────────

describe("the prepared human diff + the signature state (coupled)", () => {
  const doc = readFileSync(DIFF_DOC, "utf8");

  it("the diff document exists and covers all four cards, the provenance record, and the pin revision", () => {
    expect(existsSync(DIFF_DOC)).toBe(true);
    for (const role of ["hypothesizer", "experimenter", "analyzer", "implementer"]) {
      expect(doc).toContain(role);
    }
    expect(doc).toContain(".seed-provenance.json");
    expect(doc).toContain(pin.vault_revision);
  });

  it("the doc's signature status matches the suite's gate switch (flip both together, or neither)", () => {
    if (SEED_GATE_SIGNED) {
      expect(doc).not.toMatch(/Status:\s*PENDING SIGNATURE/i);
    } else {
      expect(doc).toMatch(/Status:\s*PENDING SIGNATURE/i);
    }
  });

  it("an UNSIGNED tree cannot claim an amendment (review A1): !SEED_GATE_SIGNED ⇒ provenance.amended !== true", () => {
    if (!SEED_GATE_SIGNED) {
      const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as { amended?: boolean; amendment_signed_by?: string };
      expect(provenance.amended, "an unsigned tree must not carry an amendment claim in .seed-provenance.json").not.toBe(true);
    }
  });
});

// ── coherent overlap anchors — the SHIPPED-CARD halves are pinned now; the ────
// ── fixture halves are held pending signature (B1) ───────────────────────────

/** One anchor of the overlap: the card-side regex pins NOW (live repo
 *  source, unflagged content); the fixture-side half is a named skip that
 *  converts with the signature + the re-published fixtures. */
const overlapAnchor = (label: string, card: string, cardRe: RegExp) => {
  it(`coherent (shipped card): ${label}`, () => {
    expect(cardRe.test(cardText(card)), `${card} carries the anchor: ${cardRe}`).toBe(true);
  });
};

describe("implementer ↔ engineer (engine-neutral) — coherent overlap, shipped-card halves pinned", () => {
  overlapAnchor("the delegated TDD leaf (implement-issue --orchestrated)", "implementer", /implement-issue/);
  overlapAnchor("the orchestrated worktree binding", "implementer", /--orchestrated/);
  overlapAnchor("branch discipline — never off the assigned branch", "implementer", /caller-provided worktree branch/);
  overlapAnchor("test protection — never force green", "implementer", /never delete, skip, or mark tests broken to\s+force green/);
  overlapAnchor("the structured return contract", "implementer", /commit_shas/);
  overlapAnchor("bounded retries, then escalate — never negotiate a RED", "implementer", /is a `failed` return,\s+not a negotiation/);
});

describe("experimenter ↔ experimenter (engine-neutral) — coherent overlap, shipped-card halves pinned", () => {
  overlapAnchor("brief-driven execution — parse the briefing first", "experimenter", /Briefing you receive:/);
  overlapAnchor("numbers-grounded reporting from the run's own output", "experimenter", /Debrief with NUMBERS ONLY/);
});

describe("coherent overlap — the fixture halves, held pending signature (B1)", () => {
  const FIXTURE_HALVES = [
    { key: "fixture publication: engineer.md (full vault definition)", file: "engineer.md", re: /NEVER delete test files or remove test cases/ },
    { key: "fixture publication: experimenter.md (full vault definition)", file: "experimenter.md", re: /AMICO_RESULT_/ },
  ];
  for (const f of FIXTURE_HALVES) {
    it.skip(`PENDING SIGNATURE — the pinned ${f.file} carries the coherent anchor ${f.re} (${f.key}) — see docs/seed-gate/role-cards-seed-diff.md`, () => {
      expect(f.re.test(readFileSync(join(FIXTURES, f.file), "utf8"))).toBe(true);
    });
  }
});

// ── flagged content — pending-signature skips (never a silent pass) ─────────

/** The flags the prepared diff marks divergent — PLUS the B1 fixture
 *  publication holds. Keys must appear verbatim in
 *  docs/seed-gate/role-cards-seed-diff.md (the guard below enforces BOTH
 *  directions: a suite flag missing from the doc, or a doc flag key with no
 *  suite handling, fails). */
const FLAGGED = [
  {
    key: "implementer ↔ engineer: merge/PR governance",
    card: "implementer",
    fixture: "engineer.md",
    flag:
      "the shipped card never opens PRs, never merges, never pushes (the walk owns the lifecycle); the vault def frontmatter says 'Auto-merges when all quality gates pass'",
  },
  {
    key: "implementer ↔ engineer: scope perimeter",
    card: "implementer",
    fixture: "engineer.md",
    flag:
      "one issue slice per cast (shipped) vs the standalone experiment-mode engineering brief with layer skills and per-task PRs (vault)",
  },
  {
    key: "experimenter ↔ experimenter: self-grading and self-promotion",
    card: "experimenter",
    fixture: "experimenter.md",
    flag:
      "the shipped card never grades its own result and never promotes (gates + parent + analyzer do); the vault def compares against the incumbent and saves to the catalog itself",
  },
  {
    key: "experimenter ↔ experimenter: environment/checkout discipline",
    card: "experimenter",
    fixture: "experimenter.md",
    flag:
      "assigned isolated env per sessions/CHECKOUTS.md (shipped) vs scratchpad paths with no checkout registry (vault)",
  },
  {
    key: "experimenter ↔ experimenter: artifact contract",
    card: "experimenter",
    fixture: "experimenter.md",
    flag:
      "raw artifacts + house-frontmatter experiment note (shipped) vs TSV rows + catalog saves (vault)",
  },
  {
    key: "hypothesizer ↔ vault counterpart",
    card: "hypothesizer",
    fixture: "researcher.md",
    flag:
      "no engine-neutral counterpart; nearest kin researcher.md is a decider with a different output — the signature confirms no-counterpart or names the pin target",
  },
  {
    key: "analyzer ↔ vault counterpart",
    card: "analyzer",
    fixture: "librarian.md",
    flag:
      "no engine-neutral counterpart; nearest kin librarian.md writes curated notes where the analyzer is read-only and proposes verdicts — the signature confirms no-counterpart or names the pin target",
  },
  {
    key: "fixture publication: engineer.md (full vault definition)",
    card: "implementer",
    fixture: "engineer.md",
    flag:
      "the engineer definition as a committed fixture failed the amended content policy's per-line test (src/ module tree, how-to-extend recipe, Complex Internals section, roadmap lines) — unpublished pending signature; the vault re-authoring is the recorded follow-up",
  },
  {
    key: "fixture publication: experimenter.md (full vault definition)",
    card: "experimenter",
    fixture: "experimenter.md",
    flag:
      "the experimenter definition as a committed fixture failed the per-line test (literal internal host paths) — unpublished pending signature; the vault re-authoring is the recorded follow-up",
  },
] as const;

describe("flagged content is pinned only after Aaron signs (the seed gate)", () => {
  // The skips are the gate's honest pre-signature state: each names its flag
  // and cites the diff document. When the signature lands (SEED_GATE_SIGNED
  // flipped together with the doc's signature block), convert each to a
  // live pin asserting the ADJUDICATED direction per the spec's constraint
  // of record (repo wins for shipped bindings; the vault def keeps the
  // engine-neutral semantics it still owns).
  for (const f of FLAGGED) {
    it.skip(`PENDING SIGNATURE — ${f.key}: ${f.flag} (see docs/seed-gate/role-cards-seed-diff.md)`, () => {
      expect(true).toBe(true);
    });
  }

  it("no silent passes, direction 1: every flag the suite skips appears verbatim in the prepared diff document", () => {
    const doc = readFileSync(DIFF_DOC, "utf8");
    for (const f of FLAGGED) {
      expect(doc, `the diff doc flags: ${f.key}`).toContain(f.key);
    }
  });

  it("no silent passes, direction 2 (review A2): every bold flag key in the doc's Flagged-for-signature sections has a suite FLAGGED entry", () => {
    const doc = readFileSync(DIFF_DOC, "utf8");
    // the doc's flag keys live ONLY in the flag sections: "Flagged for
    // signature", the held-publication section, and the NO-counterpart
    // sections (their "suite flag:" markers). Scoping matters — the
    // coherent-anchor sections also carry bold-backtick quotes of card
    // text, and those are NOT flags.
    const FLAG_SECTION = /Flagged for signature|held pending signature|NO vault counterpart/;
    const sections = doc.split(/^#{2,3} /m);
    const docKeys: string[] = [];
    for (const section of sections) {
      const heading = section.slice(0, section.indexOf("\n"));
      if (!FLAG_SECTION.test(heading)) continue;
      docKeys.push(...[...section.matchAll(/\*\*`([^`]+)`/g)].map((m) => m[1]!));
    }
    expect(docKeys.length, "the doc's flag sections carry bold flag keys").toBeGreaterThanOrEqual(FLAGGED.length);
    const suiteKeys = new Set(FLAGGED.map((f) => f.key));
    for (const key of docKeys) {
      expect(suiteKeys.has(key), `the suite carries a FLAGGED entry for the doc's flag key: ${key}`).toBe(true);
    }
  });
});

// ── post-signature pins (dormant until the signature flips the switch) ──────

describe.skipIf(!SEED_GATE_SIGNED)("post-signature: the adjudicated overlap of record (repo wins for shipped bindings)", () => {
  it("the shipped implementer stays merge-free: no PR/merge/push authorization enters the binding", () => {
    expect(cardText("implementer")).toMatch(/never opens PRs, never merges/);
    expect(cardText("implementer")).not.toMatch(/auto-merge/i);
  });
  it("the shipped experimenter stays grade-free: verdicts belong to the gates + parent + analyzer", () => {
    expect(cardText("experimenter")).toMatch(/do NOT declare confirm\/refute/);
    expect(cardText("experimenter")).not.toMatch(/save the pulse to the catalog/);
  });
  it("the no-counterpart verdicts the signature confirmed are recorded in pin.json", () => {
    const confirmed = JSON.parse(readFileSync(PIN_PATH, "utf8")) as PinRecord;
    expect(confirmed.no_counterpart.map((n) => n.role_card).sort()).toEqual(["analyzer", "hypothesizer"]);
  });

  // review A3: the three previously unenforced flags convert with the
  // switch too — each carries the repo-wins direction inline, so flipping
  // SEED_GATE_SIGNED converts ALL of the flags, not four of seven.
  it("A3 scope perimeter: the shipped implementer stays one-slice-per-cast; no layer-skill/multi-package scope enters the binding", () => {
    expect(cardText("implementer")).toMatch(/Implements ONE TDD-ready GitHub issue slice/);
    expect(cardText("implementer")).not.toMatch(/layer skill|multi-package/i);
  });
  it("A3 checkout discipline: the shipped experimenter keeps the assigned-env/CHECKOUTS.md rule; no scratchpad free-for-all", () => {
    expect(cardText("experimenter")).toMatch(/USE EXACTLY THIS, never a shared checkout/);
    expect(cardText("experimenter")).not.toMatch(/scratchpad/);
  });
  it("A3 artifact contract: the shipped experimenter writes its own experiment note + raw artifacts, never catalog writes", () => {
    expect(cardText("experimenter")).toMatch(/write YOUR\s+own experiment note|Write raw artifacts/);
    expect(cardText("experimenter")).not.toMatch(/save the pulse to the catalog/);
  });
});
