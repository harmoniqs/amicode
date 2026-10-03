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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { validateClaim, type ClaimType } from "@amicode/schema";

function pythonBin(): string {
  return process.env.AMICO_PYTHON && process.env.AMICO_PYTHON.trim() !== "" ? process.env.AMICO_PYTHON : "python3";
}

import {
  parseMemoryCard,
  parseClaimNote,
  projectMemoryCard,
  renderClaimNote,
  lintClaimsRegistry,
  MEMORY_CARD_TYPES,
  MEMORY_CARD_TO_CLAIM_TYPE,
  claimFileBasename,
  memoryCardPointer,
  claimScore,
  loadRegistryClaims,
  renderIndexView,
  INDEX_MAX_LINES,
  INDEX_DEFAULT_PER_TYPE,
} from "../src/claims.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const CARD_REL = "project_two_qubit_challenge.md";
const CARD_FILE = join(FIXTURES, "vault", "amicode", "memory", CARD_REL);
const REGISTRY_FIXTURE = join(FIXTURES, "registry", "project_two_qubit_challenge.md");
const VAULT_FIXTURE = join(FIXTURES, "vault");

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

// ── the fixture of record (AC 4 — the pack.toml discipline: the committed
// fixture IS the contract; a renderer or schema change must fail here) ─────────
describe("the committed fixture of record", () => {
  it("the registry fixture's frontmatter key set is EXACTLY the 10 contract keys", () => {
    const parsed = parseClaimNote(readFileSync(REGISTRY_FIXTURE, "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.claim).sort()).toEqual(
        ["applied", "confidence", "evidence", "history", "last_applied", "scope", "statement", "status", "tags", "type"],
      );
      expect(validateClaim(parsed.claim)).toEqual({ ok: true, errors: [] });
    }
  });

  it("the projection of the committed card reproduces the committed claim note BYTE-IDENTICAL (renderer + fixture pinned together)", () => {
    const card = parseMemoryCard(readFileSync(CARD_FILE, "utf8"));
    const note = renderClaimNote(projectMemoryCard(card, { cardRel: CARD_REL, projectedAt: PROJECTED_AT }), card, CARD_REL);
    expect(note).toBe(readFileSync(REGISTRY_FIXTURE, "utf8"));
  });

  it("the fixture registry lints clean against the fixture vault (substrates resolve)", () => {
    const r = lintClaimsRegistry(join(FIXTURES, "registry"), { vaultRoot: VAULT_FIXTURE });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(["project_two_qubit_challenge.md"]);
  });
});

// ── the registry lint (AC 2: unknown types, unresolved evidence pointers,
// missing required fields — each flagged, field-precise) ───────────────────────
describe("the claims registry lint (#1681, AC 2)", () => {
  const CARD_RAW = readFileSync(CARD_FILE, "utf8");

  function writeRegistry(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "claims-lint-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  /** The minimal clean claim as a note body — each case below perturbs it. */
  function claimNote(overrides: Record<string, unknown>): string {
    const claim = {
      type: "insight",
      statement: "a clean statement",
      status: "unverified",
      confidence: "medium",
      evidence: ["memory-card/project_two_qubit_challenge.md"],
      applied: 0,
      last_applied: null,
      history: [{ date: "2026-10-02T12:00:00.000Z", event: "projected", note: "fixture" }],
      scope: "personal",
      tags: [],
      ...overrides,
    };
    return `---\n${stringify(claim, { lineWidth: 0 })}---\n\nbody\n`;
  }

  it("flags an unknown type — the memory namespace has no slot in the claims registry (the collision, dissolved)", () => {
    const dir = writeRegistry({ "unprojected.md": claimNote({ type: "feedback" }) });
    const r = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes("unprojected.md") && f.includes("/type") && f.includes("(insight, hypothesis, best-practice, hazard, method)"))).toBe(true);
  });

  it("flags missing required fields, naming each", () => {
    const dir = writeRegistry({ "incomplete.md": claimNote({ statement: undefined, applied: undefined }) });
    const r = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes('missing required key "statement"'))).toBe(true);
    expect(r.findings.some((f) => f.includes('missing required key "applied"'))).toBe(true);
  });

  it("flags an unresolved memory-card pointer — evidence must resolve into the substrate", () => {
    const dir = writeRegistry({ "dangling.md": claimNote({ evidence: ["memory-card/gone.md"] }) });
    const r = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes("dangling.md: memory-card/gone.md: unresolved"))).toBe(true);
  });

  it("flags memory-card pointers when no vault substrate is given (never a silent pass) and flags unknown pointer kinds", () => {
    const noVault = lintClaimsRegistry(writeRegistry({ "a.md": claimNote({}) }), {});
    expect(noVault.findings.some((f) => f.includes("no vault substrate"))).toBe(true);

    const weirdKind = lintClaimsRegistry(writeRegistry({ "b.md": claimNote({ evidence: ["notion/xyz"] }) }), { vaultRoot: VAULT_FIXTURE });
    expect(weirdKind.findings.some((f) => f.includes('unknown pointer kind "notion"'))).toBe(true);

    const malformed = lintClaimsRegistry(writeRegistry({ "c.md": claimNote({ evidence: ["memory-card"] }) }), { vaultRoot: VAULT_FIXTURE });
    expect(malformed.findings.some((f) => f.includes("malformed evidence pointer"))).toBe(true);
  });

  it("resolves chat-session / chat-message pointers against the chat DB (read-only) and flags them without one", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "claims-db-"));
    const db = join(dbDir, "chat.db");
    execFileSync(pythonBin(), ["-c", `
import sqlite3
con = sqlite3.connect(${JSON.stringify(db)})
con.executescript("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY);")
con.execute("INSERT INTO session (id) VALUES ('ses_123')")
con.execute("INSERT INTO message (id) VALUES ('msg_456')")
con.commit(); con.close()
`, ], { encoding: "utf8" });

    const ok = lintClaimsRegistry(
      writeRegistry({ "chat.md": claimNote({ evidence: ["chat-session/ses_123", "chat-message/msg_456"] }) }),
      { db },
    );
    expect(ok.findings).toEqual([]);

    const dangling = lintClaimsRegistry(
      writeRegistry({ "chat.md": claimNote({ evidence: ["chat-session/ses_gone"] }) }),
      { db },
    );
    expect(dangling.findings.some((f) => f.includes("chat-session/ses_gone: unresolved"))).toBe(true);

    const noDb = lintClaimsRegistry(writeRegistry({ "chat.md": claimNote({ evidence: ["chat-session/ses_123"] }) }), { vaultRoot: VAULT_FIXTURE });
    expect(noDb.findings.some((f) => f.includes("chat-session/ses_123: unresolved"))).toBe(true);
  });

  it("enforces the #1679 invariant: zero evidence cannot sit past unverified", () => {
    const dir = writeRegistry({ "bold.md": claimNote({ status: "corroborated", evidence: [] }) });
    const r = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes('status "corroborated" with zero evidence'))).toBe(true);
    // an unverified claim with zero evidence is legal (it just cannot advance)
    const fine = writeRegistry({ "humble.md": claimNote({ evidence: [] }) });
    expect(lintClaimsRegistry(fine, { vaultRoot: VAULT_FIXTURE }).ok).toBe(true);
  });

  it("an unreadable chat substrate is a NAMED finding, never a crash — chat pointers stay flagged, not waved through", () => {
    const dbDir = mkdtempSync(join(tmpdir(), "claims-db-"));
    const garbage = join(dbDir, "not-a-db");
    writeFileSync(garbage, "definitely not sqlite\n");
    const r = lintClaimsRegistry(
      writeRegistry({ "chat.md": claimNote({ evidence: ["chat-session/ses_123"] }) }),
      { db: garbage },
    );
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes("chat substrate unreadable"))).toBe(true);
    expect(r.findings.some((f) => f.includes("chat-session/ses_123: unresolved"))).toBe(true);
  });

  it("flags a malformed note and ignores subdirectories (candidates/ is not the registry proper)", () => {
    const dir = writeRegistry({ "broken.md": "no frontmatter at all\n" });
    const r = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.includes("broken.md: no YAML frontmatter"))).toBe(true);

    mkdirSync(join(dir, "candidates"));
    writeFileSync(join(dir, "candidates", "junk.md"), "anything\n");
    const after = lintClaimsRegistry(dir, { vaultRoot: VAULT_FIXTURE });
    expect(after.files).toEqual(["broken.md"]);
  });
});

// ── the hot-layer index (amicode #1682, brain flywheel slice 3 — MEMORY.md
// becomes a view): the ranked rendering of the claims registry. The index is
// DERIVED, never authoritative; claims are the source of truth. ───────────────

const NOW = new Date("2026-10-02T12:00:00.000Z");
const RENDER_REGISTRY_FIXTURE = join(FIXTURES, "render-registry");
const INDEX_FIXTURE = join(FIXTURES, "index", "MEMORY.md");

/** A clean synthetic claim at the contract's 10 keys — each ranking test
 *  perturbs exactly one axis. */
function aClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "insight",
    statement: "a statement",
    status: "unverified",
    confidence: "medium",
    evidence: ["memory-card/project_two_qubit_challenge.md"],
    applied: 0,
    last_applied: null,
    history: [{ date: "2026-09-01T00:00:00.000Z", event: "created", note: "fixture" }],
    scope: "personal",
    tags: [],
    ...overrides,
  };
}

describe("the hot-layer index ranking (#1682, AC 1-2 — recency × adoption × confidence)", () => {
  it("claimScore is the equal-thirds composite over [0,1] axes: fresh+adopted+high ≈ 3, stale+unapplied+low ≈ 0.3", () => {
    const hot = claimScore(
      aClaim({
        confidence: "high",
        applied: 999_999,
        history: [{ date: NOW.toISOString(), event: "created", note: "x" }],
      }),
      NOW,
    );
    expect(hot).toBeCloseTo(3, 5);
    const cold = claimScore(aClaim({ confidence: "low", history: [{ date: "1990-01-01T00:00:00.000Z", event: "created", note: "x" }] }), NOW);
    expect(cold).toBeCloseTo(0.3, 5);
  });

  it("a claim with NO parseable history date scores on adoption+confidence alone (recency is never invented)", () => {
    const noHistory = claimScore(aClaim({ applied: 1, history: [] }), NOW);
    expect(noHistory).toBeCloseTo(0.5 + 0.6, 5); // 1/2 adoption + medium
  });

  it("higher RECENCY outranks lower (fixture-pinned ordering)", () => {
    const fresh = { file: "z_fresh.md", claim: aClaim({ history: [{ date: "2026-10-01T00:00:00.000Z", event: "created", note: "x" }] }) };
    const stale = { file: "a_stale.md", claim: aClaim({ history: [{ date: "2026-08-01T00:00:00.000Z", event: "created", note: "x" }] }) };
    // file names chosen against the tiebreak: z_ sorts after a_, so only the
    // score can produce this order
    const r = renderIndexView([stale, fresh], { now: NOW });
    expect(r.ranked.map((c) => c.file)).toEqual(["z_fresh.md", "a_stale.md"]);
  });

  it("higher ADOPTION outranks lower (fixture-pinned ordering)", () => {
    const used = { file: "z_used.md", claim: aClaim({ applied: 4 }) };
    const unused = { file: "a_unused.md", claim: aClaim({ applied: 0 }) };
    const r = renderIndexView([unused, used], { now: NOW });
    expect(r.ranked.map((c) => c.file)).toEqual(["z_used.md", "a_unused.md"]);
  });

  it("higher CONFIDENCE outranks lower (fixture-pinned ordering)", () => {
    const hi = { file: "z_hi.md", claim: aClaim({ confidence: "high" }) };
    const lo = { file: "a_lo.md", claim: aClaim({ confidence: "low" }) };
    const r = renderIndexView([lo, hi], { now: NOW });
    expect(r.ranked.map((c) => c.file)).toEqual(["z_hi.md", "a_lo.md"]);
  });

  it("equal scores tiebreak deterministically on the claim file (stable order — idempotent re-render)", () => {
    const claims = [
      { file: "b.md", claim: aClaim() },
      { file: "a.md", claim: aClaim() },
      { file: "c.md", claim: aClaim() },
    ];
    const first = renderIndexView(claims, { now: NOW }).ranked.map((c) => c.file);
    const second = renderIndexView([...claims].reverse(), { now: NOW }).ranked.map((c) => c.file);
    expect(first).toEqual(["a.md", "b.md", "c.md"]);
    expect(second).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("the hot-layer index caps + lifecycle filter (#1682, AC 1)", () => {
  it("caps PER DOMAIN: 12 same-score insight claims → 10 insight bullets at the default cap; other types unaffected", () => {
    const insights = Array.from({ length: 12 }, (_, i) => ({ file: `i${String(i).padStart(2, "0")}.md`, claim: aClaim() }));
    const hazard = { file: "h.md", claim: aClaim({ type: "hazard", confidence: "low" }) };
    const r = renderIndexView([...insights, hazard], { now: NOW });
    expect(r.ranked.filter((c) => c.claim.type === "insight").length).toBe(INDEX_DEFAULT_PER_TYPE);
    expect(r.ranked.some((c) => c.file === "h.md")).toBe(true);
    expect(r.capped.length).toBe(2);
  });

  it("the GLOBAL cap is the plugin reader's line cap — never emit what the reader truncates", () => {
    const flood = Array.from({ length: 60 }, (_, i) => ({
      file: `h${String(i).padStart(2, "0")}.md`,
      claim: aClaim({ type: "hazard" }),
    }));
    const r = renderIndexView(flood, { now: NOW, capPerType: 100 });
    expect(r.ranked.length).toBe(INDEX_MAX_LINES);
  });

  it("superseded and refuted claims stay OUT of the hot layer, named in excluded", () => {
    const live = { file: "live.md", claim: aClaim() };
    const sup = { file: "sup.md", claim: aClaim({ status: "superseded" }) };
    const ref = { file: "ref.md", claim: aClaim({ status: "refuted" }) };
    const r = renderIndexView([sup, ref, live], { now: NOW });
    expect(r.ranked.map((c) => c.file)).toEqual(["live.md"]);
    expect(r.excluded.length).toBe(2);
    expect(r.excluded.some((e) => e.includes("sup.md") && e.includes("superseded"))).toBe(true);
    expect(r.excluded.some((e) => e.includes("ref.md") && e.includes("refuted"))).toBe(true);
  });

  it("the loader skips and NAMES invalid claim notes — a broken note never crashes or sneaks into the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-load-"));
    writeFileSync(join(dir, "good.md"), "---\ntype: insight\nstatement: good\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-09-01T00:00:00.000Z\n    event: created\n    note: f\nscope: personal\ntags: []\n---\n\nbody\n");
    writeFileSync(join(dir, "broken.md"), "no frontmatter at all\n");
    writeFileSync(join(dir, "invalid.md"), "---\ntype: rant\nstatement: bad\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory: []\nscope: personal\ntags: []\n---\n\nbody\n");
    const { claims, skipped } = loadRegistryClaims(dir);
    expect(claims.map((c) => c.file)).toEqual(["good.md"]);
    expect(skipped.some((s) => s.includes("broken.md"))).toBe(true);
    expect(skipped.some((s) => s.includes("invalid.md") && s.includes("/type"))).toBe(true);
  });
});

describe("the hot-layer index rendering (#1682, AC 3-4 — provenance header + the bullet-line reader)", () => {
  it("each bullet links its claim note and carries the ranking signals", () => {
    const r = renderIndexView(
      [
        {
          file: "warm.md",
          claim: aClaim({
            type: "best-practice",
            status: "corroborated",
            confidence: "high",
            applied: 3,
            statement: "warm-start from the bank",
          }),
        },
      ],
      { now: NOW },
    );
    expect(r.text).toContain("- [warm-start from the bank](../claims/warm.md) — best-practice · corroborated · high · applied 3×");
  });

  it("long statements truncate deterministically for a one-line pointer", () => {
    const long = "x".repeat(200);
    const r = renderIndexView([{ file: "long.md", claim: aClaim({ statement: long }) }], { now: NOW });
    expect(r.text).toContain(`- [${"x".repeat(159)}…](../claims/long.md)`);
    expect(r.text.split("\n").filter((l) => l.startsWith("- "))[0]!.length).toBeLessThan(250);
  });

  it("the provenance header: derived-not-authoritative, regenerate-by-design — and NO header line can eat a bullet slot", () => {
    const r = renderIndexView([{ file: "a.md", claim: aClaim() }], { now: NOW });
    for (const needle of ["generated view", "amico claims render", "#1682", "hand-edits are regenerated away by design", "claims registry"])
      expect(r.text).toContain(needle);
    // the plugin reader takes EVERY "- " line, header included — the header's
    // lines must never start with "- "
    const beforeBullets = r.text.split("\n").filter((l) => !l.startsWith("- ")).filter((l) => l.trim() !== "");
    expect(beforeBullets.every((l) => !l.startsWith("- "))).toBe(true);
    expect(beforeBullets.length).toBe(7); // exactly the HTML-comment block (<!--, 5 lines, -->)
  });

  it("deterministic: same claims + same clock → byte-identical view (idempotent re-render)", () => {
    const claims = [
      { file: "a.md", claim: aClaim() },
      { file: "b.md", claim: aClaim({ applied: 2, confidence: "high" }) },
    ];
    expect(renderIndexView(claims, { now: NOW }).text).toBe(renderIndexView(claims, { now: NOW }).text);
  });

  it("the committed fixture of record: the render registry renders BYTE-IDENTICAL to the committed index", () => {
    const { claims, skipped } = loadRegistryClaims(RENDER_REGISTRY_FIXTURE);
    expect(skipped).toEqual([]);
    expect(claims.length).toBe(5);
    const r = renderIndexView(claims, { now: NOW });
    expect(r.ranked.map((c) => c.file)).toEqual([
      "best_practice_warm_start.md",
      "insight_recent_unverified.md",
      "insight_two_qubit_challenge.md",
    ]);
    expect(r.excluded.length).toBe(2); // the refuted hazard + the superseded method
    expect(r.text).toBe(readFileSync(INDEX_FIXTURE, "utf8"));
  });

  it("the fixture render registry stays lint-clean against the fixture vault (the slice-2 contract holds)", () => {
    const r = lintClaimsRegistry(RENDER_REGISTRY_FIXTURE, { vaultRoot: VAULT_FIXTURE });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
