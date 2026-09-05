// role_cards_parity.test.ts — the parity half of the seed gate (slice 2 /
// D3, #806, AC3 + AC4, spec-20260905-063000 D3): the shipped role cards are
// the opencode bindings; the amicissimo vault's agent records are the
// engine-neutral contracts; THIS suite keeps the overlap coherent.
//
// The fixtures are REVISION-PINNED: test/fixtures/vault-agents/ carries the
// engine-neutral definitions at the amicissimo revision recorded in pin.json
// (the fixture carries the vault revision it pinned), digest-verified
// against the record — the pin is self-contained on machines without the
// vault checkout. The nightly pin-behind-HEAD check (ops/role-parity,
// riding the doctor's fleet cadence on the vault-visible machine) re-checks
// the pin against the live amicissimo checkout and files a chore issue on
// drift (obligation O8).
//
// THE GATE, honored mechanically (never prose):
//   - COHERENT anchors (both texts agree) are pinned NOW, against BOTH the
//     shipped card and the pinned fixture — the overlap stays coherent.
//   - FLAGGED content (the prepared human diff,
//     docs/seed-gate/role-cards-seed-diff.md, marks it divergent) is pinned
//     only after AARON signs. Pre-signature those anchors are SKIPS whose
//     reasons name the flag and cite the diff document — a silent pass does
//     not exist: a guard test asserts every flag the skips carry appears in
//     the diff document, and the doc's signature status must match the
//     suite's SEED_GATE_SIGNED switch (flip BOTH, in the same change, with
//     the signature).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");
const AGENTS_DIR = join(EXT, "agents");
const FIXTURES = join(HERE, "fixtures", "vault-agents");
const PIN_PATH = join(FIXTURES, "pin.json");
const DIFF_DOC = join(HERE, "..", "..", "..", "docs", "seed-gate", "role-cards-seed-diff.md");

/** The seed gate's switch of record. Flip to true ONLY in the same change
 *  that lands Aaron's signature in docs/seed-gate/role-cards-seed-diff.md
 *  (the coupling test below fails otherwise — never flip it alone). */
const SEED_GATE_SIGNED = false;

interface PinRecord {
  record_version: number;
  vault_repo: string;
  vault_revision: string;
  pinned: Array<{ role_card: string; vault_path: string; fixture: string; sha256: string }>;
  no_counterpart: Array<{ role_card: string; nearest_kin: string; reason: string }>;
}

const pin = JSON.parse(readFileSync(PIN_PATH, "utf8")) as PinRecord;
const cardText = (name: string): string => readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const sha256 = (p: string): string =>
  "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");

// ── the revision-pinned fixtures (AC3) ───────────────────────────────────────

describe("the parity fixtures are revision-pinned (the fixture carries the vault revision)", () => {
  it("pin.json carries a real amicissimo revision and both overlapping definitions", () => {
    expect(pin.record_version).toBe(1);
    expect(pin.vault_repo).toBe("harmoniqs/amicissimo");
    expect(pin.vault_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.pinned.map((p) => p.role_card).sort()).toEqual(["experimenter", "implementer"]);
  });

  it("fixture integrity: every committed fixture byte-matches its recorded digest (self-contained pin)", () => {
    for (const p of pin.pinned) {
      expect(existsSync(join(FIXTURES, p.fixture)), `fixture ${p.fixture} committed`).toBe(true);
      expect(sha256(join(FIXTURES, p.fixture))).toBe(p.sha256);
    }
  });

  it("the no-counterpart roles are RECORDED with reasons, never silently unpinned", () => {
    expect(pin.no_counterpart.map((n) => n.role_card).sort()).toEqual(["analyzer", "hypothesizer"]);
    for (const n of pin.no_counterpart) {
      expect(n.reason.length).toBeGreaterThan(20);
    }
  });
});

// ── the seed-gate record (AC4) ──────────────────────────────────────────────

describe("the prepared human diff + the signature state", () => {
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
});

// ── coherent overlap anchors — pinned NOW (the gate does not block agreement) ─

/** One anchor of the overlap: a regex that must hit the shipped card AND one
 *  that must hit the pinned fixture. Both sides assert — coherence, not
 *  just shape. */
const overlapAnchor = (label: string, card: string, cardRe: RegExp, fixture: string, fixtureRe: RegExp) =>
  it(`coherent: ${label}`, () => {
    expect(cardRe.test(cardText(card)), `${card} carries the anchor: ${cardRe}`).toBe(true);
    expect(fixtureRe.test(fixtureText(fixture)), `the pinned ${fixture} carries the anchor: ${fixtureRe}`).toBe(true);
  });

describe("implementer ↔ engineer (engine-neutral) — coherent overlap, pinned", () => {
  overlapAnchor("the delegated TDD leaf (implement-issue --orchestrated)", "implementer", /implement-issue/, "engineer.md", /implement-issue/);
  overlapAnchor("the orchestrated worktree binding", "implementer", /--orchestrated/, "engineer.md", /--orchestrated/);
  overlapAnchor("branch discipline — never off the assigned branch", "implementer", /caller-provided worktree branch/, "engineer.md", /never on main/);
  overlapAnchor("test protection — never force green", "implementer", /never delete, skip, or mark tests broken to\s+force green/, "engineer.md", /NEVER delete test files or remove test cases/);
  overlapAnchor("the structured return contract", "implementer", /commit_shas/, "engineer.md", /commit_shas:/);
  overlapAnchor("bounded retries, then escalate — never negotiate a RED", "implementer", /is a `failed` return,\s+not a negotiation/, "engineer.md", /up to 2 retry cycles/);
});

describe("experimenter ↔ experimenter (engine-neutral) — coherent overlap, pinned", () => {
  overlapAnchor("brief-driven execution — parse the briefing first", "experimenter", /Briefing you receive:/, "experimenter.md", /[Ee]xperiment brief/);
  overlapAnchor("numbers-grounded reporting from the run's own output", "experimenter", /Debrief with NUMBERS ONLY/, "experimenter.md", /AMICO_RESULT_/);
});

// ── flagged content — pending-signature skips (never a silent pass) ─────────

/** The flags the prepared diff marks divergent. Keys must appear verbatim in
 *  docs/seed-gate/role-cards-seed-diff.md (guard test below). */
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

  it("no silent passes: every flag the suite skips appears verbatim in the prepared diff document", () => {
    const doc = readFileSync(DIFF_DOC, "utf8");
    for (const f of FLAGGED) {
      expect(doc, `the diff doc flags: ${f.key}`).toContain(f.key);
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
});
