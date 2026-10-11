// The triage core (amicode #1686, brain flywheel slice 7 — the two dormant
// intakes): the meeting canon reader (the vault's OWN registry is the schema of
// record — no second tagging scheme), the content-derived tag proposal (closed
// vocabularies, gaps named, never invented), next-steps → hopper proposals
// with meeting provenance, the paper → problem-card matcher and the
// claim-shaped hypothesis seed, plus the paper/meeting-note evidence-pointer
// kinds the claim lint resolves. Hermetic suite over the committed triage
// fixtures (fixture notes per intake: a pending-tag meeting, a high-relevance
// paper, real problem cards).
//
// Run: `pnpm --filter @amicode/amico-run test triage`
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaim } from "@amicode/schema";
import { lintClaimsRegistry, type LintSubstrates } from "../src/claims.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import {
  EXTRACT_MEETINGS_JOB,
  TRIAGE_PAPERS_JOB,
  loadMeetingCanon,
  matchProblemCards,
  meetingNotePointer,
  meetingSeriesKey,
  paperPointer,
  parseNextSteps,
  parsePaperNote,
  loadProblemCards,
  proposeContextLinks,
  proposeMeetingTags,
  renderHopperProposal,
  hopperBasename,
  renderHypothesisSeed,
  rewriteMeetingNote,
} from "../src/triage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "triage");
const MEETING_VAULT = join(FIXTURES, "meeting-vault");
const NOTES = join(MEETING_VAULT, "notes", "2026", "08");
const QICK_NOTE = join(NOTES, "2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md");

const QICK_MEETING = {
  basename: "2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md",
  relPath: "notes/2026/08/2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md",
  title: "QICK+Harmoniqs",
  date: "2026-08-24",
  eventId: "calqick1_20260824T200000Z",
};

// ── the canon reader (the vault's registry IS the schema of record) ─────────────

describe("loadMeetingCanon — the vault's own registry, read not redefined", () => {
  it("parses the closed Tier-1 vocabularies (meeting-types, products)", () => {
    const canon = loadMeetingCanon(join(MEETING_VAULT, "registry"));
    expect(canon.types).toContain("debrief");
    expect(canon.types).toContain("external-intro");
    expect(canon.products).toContain("amicode");
    expect(canon.products).toContain("intonato");
    // the canon's own order is preserved — deterministic proposals
    expect(canon.products[0]).toBe("piccolo");
  });

  it("names the missing internal-projects.md honestly — the projects tier has no closed vocabulary, nothing invented", () => {
    const canon = loadMeetingCanon(join(MEETING_VAULT, "registry"));
    expect(canon.projects).toBeNull();
    expect(canon.missing).toContain("internal-projects.md");
  });
});

describe("meetingSeriesKey — the recurring-series identity", () => {
  it("strips the calendar-event timestamp suffix", () => {
    expect(meetingSeriesKey("calqick1_20260824T200000Z")).toBe("calqick1");
    expect(meetingSeriesKey("caldone1_20260821T170000Z")).toBe("caldone1");
    expect(meetingSeriesKey("cal4_20260821")).toBe("cal4"); // out-of-band shape
  });
});

// ── the tag proposal (AC 1) — closed vocabularies, gaps named, never invented ──

describe("proposeMeetingTags — content-derived, canon-closed", () => {
  const canon = loadMeetingCanon(join(MEETING_VAULT, "registry"));

  function noteFm(file: string) {
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    if (!fm.ok) throw new Error(fm.error);
    return fm.data;
  }
  function bodyOf(file: string) {
    return readFileSync(file, "utf8").replace(/^---[\s\S]*?---\r?\n/, "");
  }

  it("populates tier-2 entities from the note's OWN attendees (person:) and an explicit partnership phrase (partner:)", () => {
    const p = proposeMeetingTags(noteFm(QICK_NOTE), bodyOf(QICK_NOTE), canon, { seriesNoteCount: 2 });
    expect(p.tags.entities).toContain("person:jack-champagne");
    expect(p.tags.entities).toContain("person:aaron-trowbridge");
    expect(p.tags.entities).toContain("partner:alice-and-bob"); // "collaboration with Alice and Bob" — the note's own words
    expect(p.unresolved).toEqual([]); // no ambiguity invented
  });

  it("proposes only canon-closed tier-1 values and NAMES the gaps it does not fill", () => {
    const p = proposeMeetingTags(noteFm(QICK_NOTE), bodyOf(QICK_NOTE), canon, { seriesNoteCount: 2 });
    // recurring external series → the closed set has no sync type: a named gap, never external-intro
    expect(p.tags.types).toEqual([]);
    const typeGap = p.gaps.find((g) => g.includes("types"));
    expect(typeGap).toBeDefined();
    expect(typeGap).toContain("recurring external");
    // no canon product named in the note → named gap
    expect(p.tags.products).toEqual([]);
    expect(p.gaps.some((g) => g.includes("products"))).toBe(true);
    // internal-projects.md absent → the projects tier is a named gap, never guessed
    expect(p.tags.projects).toEqual([]);
    expect(p.gaps.some((g) => g.includes("internal-projects.md"))).toBe(true);
  });

  it("a debrief title yields the debrief type (the strongest signal is the title)", () => {
    const file = join(NOTES, "2026-08-24-diode-debrief-caldebr1_20260824T180000Z.md");
    const p = proposeMeetingTags(noteFm(file), bodyOf(file), canon, { seriesNoteCount: 1 });
    expect(p.tags.types).toEqual(["debrief"]);
  });

  it("an external FIRST occurrence with no other signal proposes external-intro", () => {
    const file = join(NOTES, "2026-08-23-raise-meeting-calraise_20260823T190000Z.md");
    // external=false here — craft the external-first-occurrence case directly
    const fm = { ...noteFm(file), external: true, attendees: [], title: "Diode intro" };
    const p = proposeMeetingTags(fm, "First conversation with the Diode team.", canon, { seriesNoteCount: 1 });
    expect(p.tags.types).toEqual(["external-intro"]);
  });

  it("a raise title yields the investor type", () => {
    const file = join(NOTES, "2026-08-23-raise-meeting-calraise_20260823T190000Z.md");
    const p = proposeMeetingTags(noteFm(file), bodyOf(file), canon, { seriesNoteCount: 1 });
    expect(p.tags.types).toEqual(["investor"]);
  });

  it("tier-3 themes are free-form kebab-case derived from the note's soft topics", () => {
    const p = proposeMeetingTags(noteFm(QICK_NOTE), bodyOf(QICK_NOTE), canon, { seriesNoteCount: 2 });
    expect(p.tags.themes).toContain("calibration");
    expect(p.tags.themes).toContain("hiring");
    expect(p.tags.themes).toContain("error-correction");
  });

  it("a canon product named in the note's own text is proposed (whole-word, case-insensitive)", () => {
    const fm = { title: "Weekly sync", attendees: [] };
    const p = proposeMeetingTags(fm, "We agreed the Amicode marketing push needs Legato support.", canon, { seriesNoteCount: 3 });
    expect(p.tags.products).toEqual(["legato", "amicode"]); // canon order, deterministic
  });
});

// ── next steps → hopper proposals (AC 2) ──────────────────────────────────────

describe("parseNextSteps — the note's own checkbox list", () => {
  it("extracts owner (escaped or bare brackets) and action text", () => {
    const body = readFileSync(QICK_NOTE, "utf8").replace(/^---[\s\S]*?---\r?\n/, "");
    const steps = parseNextSteps(body);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ owner: "Jack Champagne", text: "Update Calendar: Add Brad as a permanent invite for the meeting." });
    expect(steps[1]!.owner).toBe("Aaron Trowbridge");
    expect(steps[2]!.owner).toBeNull(); // "- [ ] The group: …" — unowned, still proposed
  });

  it("no Next steps section → empty, never guessed", () => {
    expect(parseNextSteps("### Summary\n\nnothing to do\n")).toEqual([]);
  });
});

describe("hopper proposals — deterministic naming, meeting provenance", () => {
  const step = { owner: "Jack Champagne", text: "Update Calendar: Add Brad as a permanent invite for the meeting." };

  it("hopperBasename is deterministic (same note + step → same name, idempotent re-runs)", () => {
    const a = hopperBasename({ meeting: QICK_MEETING, stepIndex: 0 });
    const b = hopperBasename({ meeting: QICK_MEETING, stepIndex: 0 });
    expect(a).toBe(b);
    expect(a).toMatch(/^hopper-20260824-qick-harmoniqs-calqick1-01\.md$/);
    expect(hopperBasename({ meeting: QICK_MEETING, stepIndex: 1 })).not.toBe(a);
  });

  it("the proposal carries meeting provenance: a resolvable meeting-note pointer + the step's owner", () => {
    const text = renderHopperProposal({ meeting: QICK_MEETING, step, stepIndex: 0, totalSteps: 3 });
    const fm = parseFrontmatter(text);
    if (!fm.ok) throw new Error(fm.error);
    expect(fm.data.type).toBe("hopper");
    expect(fm.data.status).toBe("proposed");
    expect(fm.data.source).toBe(EXTRACT_MEETINGS_JOB);
    expect(fm.data.provenance).toBe(meetingNotePointer("notes/2026/08/2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md"));
    expect(fm.data.owner).toBe("Jack Champagne");
    expect(text).toContain("# Update Calendar: Add Brad as a permanent invite for the meeting.");
    // determinism: same inputs → identical bytes (the re-run no-op)
    expect(renderHopperProposal({ meeting: QICK_MEETING, step, stepIndex: 0, totalSteps: 3 })).toBe(text);
  });
});

// ── the context-links section (AC 1) ──────────────────────────────────────────

describe("proposeContextLinks — resolvable links only", () => {
  it("links the transcript sibling, prior series notes, and this pass's hopper proposals", () => {
    const r = proposeContextLinks({
      noteBasename: "2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.md",
      hasTranscript: true,
      priorSeries: ["2026-08-10-qick-harmoniqs-calqick1_20260810T200000Z.md"],
      hopperBasenames: [hopperBasename({ meeting: QICK_MEETING, stepIndex: 0 })],
    });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toContain("[[2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.transcript]]");
    expect(r.lines[1]).toContain("[[2026-08-10-qick-harmoniqs-calqick1_20260810T200000Z]]");
    expect(r.lines[2]).toContain("[[hopper-20260824-qick-harmoniqs-calqick1-01]]");
    // every link target is a basename this pass can vouch for (resolvable by construction)
    expect(r.targets).toContain("2026-08-24-qick-harmoniqs-calqick1_20260824T200000Z.transcript.md");
  });

  it("no transcript, no prior series, no steps → empty (the placeholder stays; nothing invented)", () => {
    expect(proposeContextLinks({ noteBasename: "x.md", hasTranscript: false, priorSeries: [], hopperBasenames: [] })).toEqual({ lines: [], targets: [] });
  });
});

// ── the note rewrite (AC 1) — surgical, prose untouched ────────────────────────

describe("rewriteMeetingNote — frontmatter tiers + context links, prose verbatim", () => {
  const canon = loadMeetingCanon(join(MEETING_VAULT, "registry"));
  const raw = readFileSync(QICK_NOTE, "utf8");
  const fm = parseFrontmatter(raw);
  if (!fm.ok) throw new Error(fm.error);
  const body = raw.replace(/^---[\s\S]*?---\r?\n/, "");
  const proposal = proposeMeetingTags(fm.data, body, canon, { seriesNoteCount: 2 });
  const links = proposeContextLinks({
    noteBasename: QICK_MEETING.basename,
    hasTranscript: true,
    priorSeries: ["2026-08-10-qick-harmoniqs-calqick1_20260810T200000Z.md"],
    hopperBasenames: [hopperBasename({ meeting: QICK_MEETING, stepIndex: 0 })],
  });

  it("populates the tag tiers in the vault's own arr() shape and flips status per the vault's convention", () => {
    const out = rewriteMeetingNote(raw, proposal, links.lines);
    expect(out).toContain('  entities: ["person:jack-champagne", "person:andrew-kamen", "person:aaron-trowbridge", "person:sho-uemura", "partner:alice-and-bob"]');
    expect(out).toContain("status: complete"); // the vault's own convention: tags applied → complete
    expect(out).not.toContain("status: pending-tag");
    // gaps stay empty — never invented
    expect(out).toContain("  products: []");
  });

  it("replaces the context-links placeholder with resolvable links, and touches NOTHING else in the body", () => {
    const out = rewriteMeetingNote(raw, proposal, links.lines);
    expect(out).not.toContain("- (auto-linked at curation)");
    expect(out).toContain("## Context Links");
    // the curated prose survives verbatim (machinery never edits prose)
    expect(out).toContain("## Notes (curated)\n### Summary\n\nMeeting discussions focused on upcoming hardware testing");
    expect(out).toContain("**Pursuit of Alice and Bob partnership**");
  });

  it("deterministic: same inputs → identical bytes (re-runs are no-ops)", () => {
    expect(rewriteMeetingNote(raw, proposal, links.lines)).toBe(rewriteMeetingNote(raw, proposal, links.lines));
  });

  it("refuses honestly when the note does not carry the vault's own frontmatter shapes", () => {
    expect(() => rewriteMeetingNote("no frontmatter here", proposal, [])).toThrow();
  });
});

// ── the papers intake (AC 3) ─────────────────────────────────────────────────

describe("parsePaperNote + loadProblemCards — the two intakes' own contracts", () => {
  it("parses a paper through the library-paper contract; malformed notes are named skips", () => {
    const good = parsePaperNote(readFileSync(join(FIXTURES, "papers", "paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md"), "utf8"), "papers/paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.paper.relevance).toBe("high");
    expect(good.paper.systems).toEqual(["rydberg"]);
    const bad = parsePaperNote(readFileSync(join(FIXTURES, "papers", "paper-20260914-malformed-no-identity.md"), "utf8"), "papers/paper-20260914-malformed-no-identity.md");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toContain("arxiv");
  });

  it("loads the problem cards with their platform identity", () => {
    const { cards, skipped } = loadProblemCards(join(FIXTURES, "problems"));
    expect(skipped).toEqual([]);
    expect(cards.map((c) => c.slug).sort()).toEqual(["ccz-rydberg", "cz-gate-transmon", "x-gate-rydberg-global"]);
    expect(cards.find((c) => c.slug === "ccz-rydberg")!.platform).toBe("rydberg");
  });
});

describe("matchProblemCards — platform-identity match, no fuzzy guessing", () => {
  const { cards } = loadProblemCards(join(FIXTURES, "problems"));
  const paper = parsePaperNote(readFileSync(join(FIXTURES, "papers", "paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md"), "utf8"), "papers/paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");
  if (!paper.ok) throw new Error("fixture paper must parse");

  it("a rydberg paper matches the rydberg cards (exact platform identity)", () => {
    const matched = matchProblemCards(paper.paper, cards);
    expect(matched.map((c) => c.slug).sort()).toEqual(["ccz-rydberg", "x-gate-rydberg-global"]);
  });

  it("a germanium paper matches NO card — germanium is not spin; the gap is named, never bridged by guess", () => {
    const ge = parsePaperNote(readFileSync(join(FIXTURES, "papers", "paper-20260914-borsoi-2022-ge-crossbar.md"), "utf8"), "papers/paper-20260914-borsoi-2022-ge-crossbar.md");
    if (!ge.ok) throw new Error("fixture paper must parse");
    expect(matchProblemCards(ge.paper, cards)).toEqual([]);
  });
});

describe("renderHypothesisSeed — claim-shaped, evidence-pointer to the paper", () => {
  const { cards } = loadProblemCards(join(FIXTURES, "problems"));
  const paper = parsePaperNote(readFileSync(join(FIXTURES, "papers", "paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md"), "utf8"), "papers/paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");
  if (!paper.ok) throw new Error("fixture paper must parse");
  const matched = matchProblemCards(paper.paper, cards);

  it("the seed IS a valid claim (the ONE contract) with a resolvable paper evidence pointer", () => {
    const seed = renderHypothesisSeed(paper.paper, matched);
    const v = validateClaim(seed.claim);
    if (!v.ok) throw new Error(v.errors.join("; "));
    expect(seed.claim.type).toBe("hypothesis");
    expect(seed.claim.status).toBe("unverified");
    expect(seed.claim.evidence).toEqual([paperPointer("paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md")]);
    expect(seed.claim.tags).toContain("ccz-rydberg");
    expect(seed.claim.tags).toContain("x-gate-rydberg-global");
  });

  it("the seed links the affected problem cards in its body and is deterministic", () => {
    const a = renderHypothesisSeed(paper.paper, matched);
    const b = renderHypothesisSeed(paper.paper, matched);
    expect(a.text).toBe(b.text);
    expect(a.basename).toBe("paper-20260803-231156-bhardwaj-2026-mitten-qldpc.md");
    expect(a.text).toContain("[[ccz-rydberg]]");
    expect(a.text).toContain("[[x-gate-rydberg-global]]");
    expect(a.text).toContain("[[paper-20260803-231156-bhardwaj-2026-mitten-qldpc]]");
    expect(a.text).toContain("High-rate qLDPC processors");
  });

  it("the seed's frontmatter is EXACTLY the claim object (validateClaim on the parsed note)", () => {
    const seed = renderHypothesisSeed(paper.paper, matched);
    const fm = parseFrontmatter(seed.text);
    if (!fm.ok) throw new Error(fm.error);
    expect(validateClaim(fm.data).ok).toBe(true);
  });
});

// ── the claim-layer seams: the new evidence-pointer kinds resolve in the lint ──

describe("paper/ + meeting-note/ evidence pointers — the claim lint resolves them", () => {
  /** Build a tmp vault substrate: a claims registry + a papers/ tree + a meeting vault. */
  function substrate(): { root: string; meetings: string } {
    const root = mkdtempSync(join(tmpdir(), "triage-lint-"));
    mkdirSync(join(root, "papers"), { recursive: true });
    mkdirSync(join(root, "claims"), { recursive: true });
    const meetings = join(root, "meeting-vault");
    mkdirSync(join(meetings, "notes", "2026", "08"), { recursive: true });
    writeFileSync(join(root, "papers", "paper-x.md"), "---\ntitle: X\n---\nbody\n");
    writeFileSync(join(meetings, "notes", "2026", "08", "m.md"), "---\ntitle: M\n---\nbody\n");
    return { root, meetings };
  }

  function claimNote(evidence: string[]) {
    return [
      "---",
      "type: insight",
      "statement: a seeded statement about papers and meetings",
      "status: unverified",
      "confidence: medium",
      `evidence: [${evidence.map((e) => `"${e}"`).join(", ")}]`,
      "applied: 0",
      "last_applied: null",
      "history: [{ date: 2026-10-02T12:00:00.000Z, event: created, note: fixture }]",
      "scope: personal",
      "tags: []",
      "---",
      "",
      "# a seeded statement about papers and meetings",
      "",
    ].join("\n");
  }

  it("a paper pointer resolves against the vault's papers/ tree", () => {
    const { root, meetings } = substrate();
    writeFileSync(join(root, "claims", "c.md"), claimNote([paperPointer("paper-x.md")]));
    const r = lintClaimsRegistry(join(root, "claims"), { vaultRoot: root, meetingsRoot: meetings } satisfies LintSubstrates);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("a meeting-note pointer resolves against the meeting-vault root — and is flagged, never waved, when the substrate is missing", () => {
    const { root, meetings } = substrate();
    writeFileSync(join(root, "claims", "c.md"), claimNote([meetingNotePointer("notes/2026/08/m.md")]));
    expect(lintClaimsRegistry(join(root, "claims"), { vaultRoot: root, meetingsRoot: meetings }).ok).toBe(true);
    expect(lintClaimsRegistry(join(root, "claims"), { vaultRoot: root }).ok).toBe(false);
    expect(lintClaimsRegistry(join(root, "claims"), { vaultRoot: root }).findings.join(" ")).toContain("no meeting vault given");
  });

  it("an unresolved paper pointer is a finding naming the papers tree it searched", () => {
    const { root, meetings } = substrate();
    writeFileSync(join(root, "claims", "c.md"), claimNote([paperPointer("paper-missing.md")]));
    const r = lintClaimsRegistry(join(root, "claims"), { vaultRoot: root, meetingsRoot: meetings });
    expect(r.ok).toBe(false);
    expect(r.findings.join(" ")).toContain("paper-missing.md");
    expect(r.findings.join(" ")).toContain("papers");
  });
});

// ── the job ids (the receipt's membership check) ───────────────────────────────

describe("the triage jobs' notturno ids", () => {
  it("match the spec's job registry names (extract-meetings, triage-papers)", () => {
    expect(EXTRACT_MEETINGS_JOB).toBe("extract-meetings");
    expect(TRIAGE_PAPERS_JOB).toBe("triage-papers");
  });
});
