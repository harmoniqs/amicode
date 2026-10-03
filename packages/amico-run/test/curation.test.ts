// curation.test.ts — the pure core behind the three weekly curation jobs
// (amicode #1685, brain flywheel slice 6 — promote / prune / synthesize as
// notturno jobs on the claim layer): the promotion plan (eligibility, the
// 10-cap, overflow carry), the promotion bundle rendering (PR body + copy,
// PROPOSAL ONLY — never a PR), the prune plan (unambiguous hygiene fixes vs
// drift the pass never guesses at), and the synthesize pattern detector
// (cross-claim tag clusters → hopper proposals, never strategy).
//
// Hermetic: the committed curation-registry fixture, injectable clocks —
// no live vault, no network, no git.
//
// Run: `pnpm --filter @amicode/amico-run test curation`
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  PROMOTE_JOB,
  PRUNE_JOB,
  SYNTHESIZE_JOB,
  PROMOTE_CAP,
  SYNTHESIZE_MIN_POINTS,
  SYNTHESIZE_CAP,
  planPromotion,
  readPromoteState,
  writePromoteState,
  stampPromoted,
  promoteBundleId,
  renderPrBody,
  renderPromotionCopy,
  planPrune,
  renderPruneDiff,
  detectPatterns,
  hopperSlug,
  renderHopperNote,
} from "../src/curation.js";
import { loadRegistryClaims, type RegistryClaim } from "../src/claims.js";
import { validateClaim } from "@amicode/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, "fixtures", "claims", "curation-registry");
const NOON = () => new Date("2026-10-02T12:00:00.000Z");

const { claims } = loadRegistryClaims(REGISTRY);

/** A synthetic live team claim — the cap/overflow tests build registries of these. */
function syntheticClaim(file: string, opts: { scope?: string; tags?: string[] } = {}): RegistryClaim {
  return {
    file,
    claim: {
      type: "insight",
      statement: `synthetic claim ${file}`,
      status: "unverified",
      confidence: "medium",
      evidence: [],
      applied: 0,
      last_applied: null,
      history: [{ date: "2026-10-01T00:00:00.000Z", event: "created", note: "synthetic (curation test)" }],
      scope: opts.scope ?? "team",
      tags: opts.tags ?? ["synthetic"],
    },
  };
}

describe("curation core — the notturno job ids (the registry's membership vocabulary)", () => {
  it("the three job ids are the spec's registry names", () => {
    expect(PROMOTE_JOB).toBe("promote");
    expect(PRUNE_JOB).toBe("prune");
    expect(SYNTHESIZE_JOB).toBe("synthesize");
  });
});

// ── promote ────────────────────────────────────────────────────────────────────

describe("curation core — planPromotion (eligibility, cap, overflow carry)", () => {
  it("selects exactly the scope-team live claims, deterministically sorted", () => {
    const plan = planPromotion(claims, readPromoteState(join(tmpdir(), "absent-state.json")));
    expect(plan.selected).toEqual([
      "best_practice_warm_starts.md",
      "insight_two_qubit_cr.md",
      "insight_two_qubit_harder.md",
    ]);
    expect(plan.eligible).toEqual(plan.selected);
    expect(plan.overflow).toEqual([]);
  });

  it("names its exclusions: a terminal team claim and a public-scoped claim are never silently dropped", () => {
    const plan = planPromotion(claims, readPromoteState(join(tmpdir(), "absent-state.json")));
    expect(plan.excluded.some((e) => e.includes("insight_refuted_team.md") && e.includes("refuted"))).toBe(true);
    expect(plan.excluded.some((e) => e.includes("insight_public_scope.md") && e.includes("public"))).toBe(true);
    // personal claims are simply out of the pool — not named, never guessed at
    expect(plan.excluded.some((e) => e.includes("insight_padded_tags.md"))).toBe(false);
  });

  it("a claim already proposed in the state is out of the pool (the promotion is pending a human merge)", () => {
    const state = stampPromoted(readPromoteState(join(tmpdir(), "x.json")), ["insight_two_qubit_cr.md"], {
      bundle: "promote-20261001-060000",
      proposed_at: "2026-10-01T06:00:00.000Z",
    });
    const plan = planPromotion(claims, state);
    expect(plan.eligible).not.toContain("insight_two_qubit_cr.md");
    expect(plan.selected).toEqual(["best_practice_warm_starts.md", "insight_two_qubit_harder.md"]);
  });

  it("the 10-cap holds: overflow carries (never dropped, never silently proposed past the cap)", () => {
    const many = Array.from({ length: 12 }, (_, i) => syntheticClaim(`synthetic_${String(i).padStart(2, "0")}.md`));
    const plan = planPromotion(many, readPromoteState(join(tmpdir(), "x.json")));
    expect(PROMOTE_CAP).toBe(10);
    expect(plan.selected).toHaveLength(10);
    expect(plan.overflow).toEqual(["synthetic_10.md", "synthetic_11.md"]);
  });
});

describe("curation core — the promote state stamp (the distill-state pattern)", () => {
  it("reads absent/malformed as EMPTY — fail-safe to re-propose, never to skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-state-"));
    expect(readPromoteState(join(dir, "absent.json")).proposals).toEqual({});
    writeFileSync(join(dir, "garbage.json"), "{{{not json");
    expect(readPromoteState(join(dir, "garbage.json")).proposals).toEqual({});
  });

  it("stamp + write round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-state-"));
    const path = join(dir, "promote-state.json");
    const state = stampPromoted(readPromoteState(path), ["a.md", "b.md"], {
      bundle: "promote-20261002-120000",
      proposed_at: "2026-10-02T12:00:00.000Z",
    });
    writePromoteState(path, state);
    const back = readPromoteState(path);
    expect(back.proposals["a.md"]).toEqual({ bundle: "promote-20261002-120000", proposed_at: "2026-10-02T12:00:00.000Z" });
    expect(Object.keys(back.proposals)).toEqual(["a.md", "b.md"]);
  });
});

describe("curation core — the promotion bundle rendering (PROPOSAL ONLY)", () => {
  it("the bundle id is deterministic from the injectable clock", () => {
    expect(promoteBundleId(NOON())).toBe("promote-20261002-120000");
  });

  it("the PR body carries the double gate, the branch convention, the claims table, and the cap", () => {
    const plan = planPromotion(claims, readPromoteState(join(tmpdir(), "x.json")));
    const body = renderPrBody(plan, claims, { sourceVault: "vault-aaron", bundleId: "promote-20261002-120000", now: NOON() });
    // one PR per vault, the dream-promote branch convention — pinned on the
    // header line (a render regression once left the template literal literal)
    expect(body).toContain("promote: vault-aaron → armonissima (3 claims, 2026-10-02)");
    expect(body).toContain("Branch: `promote/vault-aaron`");
    // never auto-merged: the verb proposes; a human merges
    expect(body).toContain("never opens a PR");
    expect(body).toMatch(/human/i);
    // the table names every selected claim with its statement
    for (const file of plan.selected) expect(body).toContain(file);
    expect(body).toContain("Two-qubit gates on coupled qubits are significantly harder than single-qubit gates");
    // the overflow section + the cap are explicit
    expect(body.toLowerCase()).toContain("overflow");
    expect(body).toContain("cap: 10");
  });

  it("overflow claims are listed in the body (carried to the next run, never dropped)", () => {
    const many = Array.from({ length: 12 }, (_, i) => syntheticClaim(`synthetic_${String(i).padStart(2, "0")}.md`));
    const body = renderPrBody(planPromotion(many, readPromoteState(join(tmpdir(), "x.json"))), many, {
      sourceVault: "vault-aaron",
      bundleId: "promote-20261002-120000",
      now: NOON(),
    });
    expect(body).toContain("synthetic_10.md");
    expect(body).toContain("synthetic_11.md");
  });

  it("the promotion copy preserves the claim note verbatim and appends provenance (copy-never-move)", () => {
    const raw = readFileSync(join(REGISTRY, "insight_two_qubit_harder.md"), "utf8");
    const copy = renderPromotionCopy(raw, {
      file: "insight_two_qubit_harder.md",
      sourceVault: "vault-aaron",
      bundleId: "promote-20261002-120000",
      now: NOON(),
    });
    // verbatim prefix — the frontmatter (the claim object) is untouched
    expect(copy.startsWith(raw)).toBe(true);
    expect(copy).toContain("Provenance");
    expect(copy).toContain("promote-20261002-120000");
    expect(copy).toContain("vault-aaron");
    // the copy's frontmatter still IS a valid claim (the ONE contract survives promotion)
    const fm = copy.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
    expect(fm).not.toBeNull();
    expect(validateClaim(parseYaml(fm![1]!)).ok).toBe(true);
  });
});

// ── prune ─────────────────────────────────────────────────────────────────────

describe("curation core — planPrune (unambiguous fixes only, never a guess)", () => {
  it("fixes the duplicated evidence pointer and the padded duplicate tag — the two unambiguous classes", () => {
    const plan = planPrune(claims);
    const evidence = plan.fixes.find((f) => f.file === "insight_padded_tags.md" && f.field === "evidence");
    expect(evidence).toBeDefined();
    expect(evidence!.from).toEqual(["memory-card/feedback_warm_starts.md", "memory-card/feedback_warm_starts.md"]);
    expect(evidence!.to).toEqual(["memory-card/feedback_warm_starts.md"]);
    const tags = plan.fixes.find((f) => f.file === "insight_padded_tags.md" && f.field === "tags");
    expect(tags).toBeDefined();
    expect(tags!.from).toEqual([" warm-start ", "warm-start"]);
    expect(tags!.to).toEqual(["warm-start"]);
    expect(plan.fixes).toHaveLength(2);
  });

  it("a clean claim gets no fix; the plan's claims stay valid after the fix (the contract survives hygiene)", () => {
    const plan = planPrune(claims);
    expect(plan.fixes.some((f) => f.file === "best_practice_warm_starts.md")).toBe(false);
    const fixed = plan.claims.find((c) => c.file === "insight_padded_tags.md");
    expect(fixed!.claim.evidence).toEqual(["memory-card/feedback_warm_starts.md"]);
    expect(fixed!.claim.tags).toEqual(["warm-start"]);
    for (const c of plan.claims) expect(validateClaim(c.claim).ok, c.file).toBe(true);
  });

  it("an unresolvable evidence pointer is NOT a fix — deleting a pointer would be a guess (drift is the verb's, via the lint)", () => {
    const plan = planPrune(claims);
    expect(plan.fixes.some((f) => f.file === "insight_unresolved.md")).toBe(false);
  });

  it("the hygiene diff names file, field, and before → after", () => {
    const diff = renderPruneDiff(planPrune(claims).fixes);
    expect(diff).toContain("insight_padded_tags.md");
    expect(diff).toContain("evidence");
    expect(diff).toContain("tags");
    expect(diff).toContain('"memory-card/feedback_warm_starts.md", "memory-card/feedback_warm_starts.md"');
    expect(diff).toContain("warm-start");
  });
});

// ── synthesize ────────────────────────────────────────────────────────────────

describe("curation core — detectPatterns (cross-claim clusters, the 3-point bar)", () => {
  it("three live claims sharing a tag fire ONE pattern; two do not (the quality bar)", () => {
    const { patterns } = detectPatterns(claims);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.tag).toBe("transmon");
    expect(patterns[0]!.files).toEqual([
      "best_practice_warm_starts.md",
      "insight_two_qubit_cr.md",
      "insight_two_qubit_harder.md",
    ]);
    expect(SYNTHESIZE_MIN_POINTS).toBe(3);
    expect(patterns[0]!.points).toBe(3);
  });

  it("a cross-type cluster is marked cross-cutting; confidence is medium at 3 points", () => {
    const { patterns } = detectPatterns(claims);
    expect(patterns[0]!.cross_cutting).toBe(true);
    expect(patterns[0]!.types).toEqual(["best-practice", "insight"]);
    expect(patterns[0]!.confidence).toBe("medium");
  });

  it("terminal claims never feed a pattern (refuted knowledge is out of the synthesis economy)", () => {
    const { patterns } = detectPatterns(claims);
    expect(patterns[0]!.files).not.toContain("insight_refuted_team.md");
  });

  it("confidence goes high at 5 points; the per-run cap carries overflow", () => {
    const five = detectPatterns(
      Array.from({ length: 5 }, (_, i) => syntheticClaim(`syn_${i}.md`, { scope: "personal", tags: ["alpha"] })),
    );
    expect(five.patterns[0]!.confidence).toBe("high");
    expect(SYNTHESIZE_CAP).toBe(5);

    // 7 distinct tags × 3 claims each = 7 patterns > cap 5 → overflow carries 2
    const big: RegistryClaim[] = [];
    for (const tag of ["a", "b", "c", "d", "e", "f", "g"]) {
      for (let i = 0; i < 3; i++) big.push(syntheticClaim(`${tag}${i}.md`, { scope: "personal", tags: [tag] }));
    }
    const capped = detectPatterns(big);
    expect(capped.patterns).toHaveLength(5);
    expect(capped.overflow).toEqual(["f", "g"]);
  });
});

describe("curation core — the hopper proposal rendering (proposals only, never strategy)", () => {
  it("the slug is the deterministic idempotency key", () => {
    expect(hopperSlug("transmon")).toBe("synthesize-transmon.md");
  });

  it("the note follows the hopper schema and cites the claims as evidence", () => {
    const { patterns } = detectPatterns(claims);
    const note = renderHopperNote(patterns[0]!, { now: NOON() });
    expect(note).toContain("type: hopper");
    expect(note).toContain("status: proposed");
    expect(note).toContain("promoted_to: null");
    expect(note).toContain("held_until: null");
    expect(note).toContain("date: 2026-10-02");
    expect(note).toContain("Cross-claim pattern");
    expect(note).toContain("../amicode/claims/insight_two_qubit_harder.md");
    // never strategy: the note proposes triage, it never edits a strategy file
    expect(note).toContain("never writes strategy");
  });

  it("the note names its machine provenance (the synthesize job, #1685)", () => {
    const { patterns } = detectPatterns(claims);
    expect(renderHopperNote(patterns[0]!, { now: NOON() })).toContain("synthesize");
  });
});

// ── fixture hygiene ────────────────────────────────────────────────────────────

describe("curation core — fixture hygiene", () => {
  it("the curation fixture loads as a valid claims registry (7 claims, 0 skipped)", () => {
    expect(claims).toHaveLength(7);
    expect(loadRegistryClaims(REGISTRY).skipped).toEqual([]);
  });
});
