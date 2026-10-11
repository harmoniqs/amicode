// The lifecycle pass core (amicode #1684, brain flywheel slice 5 — dedupe +
// lifecycle): the same-claim detector (merge, evidence accumulation, both
// trails preserved on the older claim), the status transitions with
// append-only history (corroborate at the evidence threshold, refute on a
// contradicted-by-run signal), and the decay review queue (a proposal surface
// — never an actor). Hermetic suite over the committed lifecycle-registry
// fixture (the pack.toml fixture discipline: the fixture of record IS the
// contract) plus synthetic claims for the pairwise edges.
//
// Run: `pnpm --filter @amicode/amico-run test lifecycle`
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaim } from "@amicode/schema";
import { loadRegistryClaims, lintClaimsRegistry, type RegistryClaim } from "../src/claims.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import {
  claimSimilarity,
  runLifecyclePass,
  renderQueueFile,
  rewriteClaimNote,
  MERGE_THRESHOLD,
  CORROBORATE_THRESHOLD,
  DECAY_WINDOW_DAYS,
  type ContradictionSignal,
} from "../src/lifecycle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const LIFECYCLE_REGISTRY = join(FIXTURES, "lifecycle-registry");
const NOW = new Date("2026-10-02T12:00:00.000Z");

/** A clean synthetic claim at the contract's 10 keys. */
function aClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "insight",
    statement: "a statement",
    status: "unverified",
    confidence: "medium",
    evidence: [],
    applied: 0,
    last_applied: null,
    history: [{ date: "2026-09-01T00:00:00.000Z", event: "created", note: "fixture" }],
    scope: "personal",
    tags: [],
    ...overrides,
  };
}

function entry(file: string, claim: Record<string, unknown>): RegistryClaim {
  return { file, claim: structuredClone(claim) };
}

// ── AC 1a: the same-claim detector — similarity over statement + tags ─────────
describe("claimSimilarity — the same-claim signal (#1684, AC 1)", () => {
  const older = aClaim({
    statement: "Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates",
    tags: ["memory", "two-qubit"],
  });
  const dup = aClaim({
    statement: "Two-qubit gates (SWAP, CX, CZ) on coupled qubits are much harder than single-qubit gates",
    tags: ["memory", "two-qubit"],
  });
  const nearMiss = aClaim({
    statement: "Breaking two-qubit gate synthesis into sub-problems converges faster",
    tags: ["memory", "two-qubit"],
  });
  const distinct = aClaim({
    statement: "Smooth pulse parameterization reliably achieves fidelity above 0.9999 on transmon X gates",
    tags: ["pulse-shape"],
  });

  it("TRUE-DUP: a re-stated claim clears the merge threshold (one word swapped, same tags)", () => {
    const s = claimSimilarity(older, dup);
    expect(s).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(s).toBeLessThan(1); // not byte-identical — similarity, not equality
  });

  it("NEAR-MISS: a topically adjacent but distinct claim stays far below the threshold", () => {
    expect(claimSimilarity(older, nearMiss)).toBeLessThan(MERGE_THRESHOLD);
    expect(claimSimilarity(dup, nearMiss)).toBeLessThan(MERGE_THRESHOLD);
  });

  it("DISTINCT: an unrelated claim scores near zero", () => {
    expect(claimSimilarity(older, distinct)).toBeLessThan(0.1);
  });

  it("identical statements + tags → exactly 1; case and punctuation are noise", () => {
    expect(claimSimilarity(older, aClaim({ statement: "two-qubit gates (swap, cx, cz) on coupled qubits are significantly harder than single-qubit GATES", tags: ["Memory", "Two-Qubit"] }))).toBe(1);
  });

  it("the STATEMENT dominates and tags refine: same statement + disjoint tags stays merge-worthy; tags alone never merge", () => {
    // same statement, disjoint tags → the statement alone carries it over the threshold
    expect(claimSimilarity(aClaim({ statement: "solo statement one", tags: ["x"] }), aClaim({ statement: "solo statement one", tags: ["y"] }))).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    // identical tags on different statements → tags alone carry nothing
    expect(claimSimilarity(older, aClaim({ statement: "an entirely unrelated statement about solvers", tags: ["memory", "two-qubit"] }))).toBeLessThan(MERGE_THRESHOLD);
  });

  it("symmetric and never above 1", () => {
    const ab = claimSimilarity(older, nearMiss);
    expect(claimSimilarity(nearMiss, older)).toBeCloseTo(ab, 10);
    expect(claimSimilarity(older, older)).toBe(1);
  });
});

// ── AC 1b: the merge — evidence accumulates, no duplicate remains, the older
// claim's identity survives with BOTH provenance trails (#1684 Key Decision) ──
describe("the dedupe-merge pass over the lifecycle fixture registry (#1684, AC 1)", () => {
  it("the fixture of record: six contract-clean claims, lint-clean against the fixture vault", () => {
    const { claims, skipped } = loadRegistryClaims(LIFECYCLE_REGISTRY);
    expect(skipped).toEqual([]);
    expect(claims.length).toBe(6);
    expect(claims.every((c) => validateClaim(c.claim).ok)).toBe(true);
    const lint = lintClaimsRegistry(LIFECYCLE_REGISTRY, { vaultRoot: join(FIXTURES, "vault") });
    expect(lint.findings).toEqual([]);
    expect(lint.ok).toBe(true);
  });

  function fixturePass() {
    const { claims } = loadRegistryClaims(LIFECYCLE_REGISTRY);
    return { input: claims, result: runLifecyclePass(claims, { now: NOW }) };
  }

  it("the fixture registry loads six claims and the pass merges exactly the true-dup pair", () => {
    const { input, result } = fixturePass();
    expect(input.length).toBe(6);
    expect(result.merges.length).toBe(1);
    const m = result.merges[0]!;
    expect(m.survivor).toBe("insight_two_qubit_challenge.md"); // the OLDER claim
    expect(m.duplicate).toBe("insight_two_qubit_harder.md");
    expect(m.similarity).toBeGreaterThanOrEqual(MERGE_THRESHOLD);
    expect(m.added_evidence).toEqual(["memory-card/reference_rho_policy.md"]);
  });

  it("MERGE SEMANTICS: evidence accumulates, both trails ride the survivor, the duplicate is gone", () => {
    const { result } = fixturePass();
    const survivor = result.claims.find((c) => c.file === "insight_two_qubit_challenge.md")!;
    expect(survivor.claim.evidence).toEqual([
      "memory-card/project_two_qubit_challenge.md",
      "memory-card/reference_rho_policy.md",
    ]);
    // identity preserved: statement, status, confidence, scope — the OLDER claim's own
    expect(survivor.claim.statement).toBe("Two-qubit gates (SWAP, CX, CZ) on coupled qubits are significantly harder than single-qubit gates");
    expect(survivor.claim.status).toBe("unverified");
    expect(survivor.claim.confidence).toBe("medium");
    expect(survivor.claim.scope).toBe("personal");
    // adoption accumulates (never silently lost)
    expect(survivor.claim.applied).toBe(1);
    expect(survivor.claim.last_applied).toBe("2026-08-25T10:00:00.000Z");
    // BOTH trails: the survivor's history, then the absorbed duplicate's, then the merge stamp LAST
    const history = survivor.claim.history as { date: string; event: string; note: string }[];
    expect(history.map((h) => h.event)).toEqual(["created", "created", "merged"]);
    expect(history[2]!.date).toBe(NOW.toISOString());
    expect(history[2]!.note).toContain("insight_two_qubit_harder.md"); // the trail names the absorbed claim
    expect(history[1]!.note).toContain("re-derived from a later campaign"); // the duplicate's own entry, preserved
    // no duplicate remains
    expect(result.claims.some((c) => c.file === "insight_two_qubit_harder.md")).toBe(false);
    expect(result.claims.length).toBe(5);
    // tags union, survivor-first order
    expect(survivor.claim.tags).toEqual(["memory", "two-qubit"]);
  });

  it("NEAR-MISS and DISTINCT stay separate — no merge, no mutation", () => {
    const { input, result } = fixturePass();
    for (const file of ["insight_two_qubit_subproblems.md", "insight_smooth_pulses.md"]) {
      expect(result.merges.some((m) => m.survivor === file || m.duplicate === file)).toBe(false);
      expect(result.claims.find((c) => c.file === file)!.claim).toEqual(input.find((c) => c.file === file)!.claim);
    }
  });

  it("the merged survivor is still a contract object (validateClaim) and the pass never mutates its input", () => {
    const { input, result } = fixturePass();
    const survivor = result.claims.find((c) => c.file === "insight_two_qubit_challenge.md")!;
    expect(validateClaim(survivor.claim)).toEqual({ ok: true, errors: [] });
    // purity: the caller's objects are untouched (a clone is returned)
    expect(input.find((c) => c.file === "insight_two_qubit_challenge.md")!.claim.applied).toBe(0);
    expect(input.length).toBe(6);
  });

  it("IDEMPOTENT: re-running the pass over its own output merges nothing more", () => {
    const { result } = fixturePass();
    const second = runLifecyclePass(result.claims, { now: NOW });
    expect(second.merges).toEqual([]);
    expect(second.claims.length).toBe(5);
  });

  it("a merge cascade converges: three pairwise-same claims collapse into the oldest with all trails + stamps", () => {
    const claim = (file: string, statement: string, created: string, evidence: string) =>
      entry(file, aClaim({ statement, evidence: [evidence], history: [{ date: created, event: "created", note: statement }] }));
    const claims = [
      claim("a.md", "alpha beta gamma", "2026-06-01T00:00:00.000Z", "memory-card/a.md"),
      claim("b.md", "alpha beta gamma delta", "2026-06-02T00:00:00.000Z", "memory-card/b.md"),
      claim("c.md", "alpha beta gamma epsilon", "2026-06-03T00:00:00.000Z", "memory-card/c.md"),
    ];
    const r = runLifecyclePass(claims, { now: NOW });
    expect(r.merges.length).toBe(2);
    expect(r.claims.length).toBe(1);
    const survivor = r.claims[0]!;
    expect(survivor.file).toBe("a.md");
    expect(survivor.claim.evidence).toEqual(["memory-card/a.md", "memory-card/b.md", "memory-card/c.md"]);
    // each merge appends the absorbed trail then its stamp — pure append, never
    // a rewrite; the accumulated evidence then carries it over the corroboration
    // threshold in the SAME pass (dedupe before corroboration)
    const events = (survivor.claim.history as { event: string }[]).map((h) => h.event);
    expect(events).toEqual(["created", "created", "merged", "created", "merged", "corroborated"]);
    expect(survivor.claim.status).toBe("corroborated");
  });

  it("merge candidacy requires the SAME type AND scope — identical statements across types never merge", () => {
    const s = "the very same addressable statement";
    const r = runLifecyclePass(
      [
        entry("a.md", aClaim({ statement: s, type: "insight" })),
        entry("b.md", aClaim({ statement: s, type: "hazard" })),
        entry("c.md", aClaim({ statement: s, scope: "team" })),
      ],
      { now: NOW },
    );
    expect(r.merges).toEqual([]);
    expect(r.claims.length).toBe(3);
  });

  it("an age tie breaks to the lexicographically-first file (deterministic survivor)", () => {
    const s = "the very same addressable statement";
    const r = runLifecyclePass(
      [
        entry("b.md", aClaim({ statement: s })),
        entry("a.md", aClaim({ statement: s })),
      ],
      { now: NOW },
    );
    expect(r.merges[0]!.survivor).toBe("a.md");
    expect(r.merges[0]!.duplicate).toBe("b.md");
  });

  it("the merge threshold is a caller-tunable pass option (fixtures pin the default)", () => {
    expect(MERGE_THRESHOLD).toBe(0.75);
    const nearMissPair = [
      entry("a.md", aClaim({ statement: "row space noise fitting beats null space fitting" })),
      entry("b.md", aClaim({ statement: "row space noise fitting loses to null space fitting" })),
    ];
    expect(runLifecyclePass(nearMissPair, { now: NOW }).merges.length).toBe(0); // default: distinct claims
    const loose = runLifecyclePass(structuredClone(nearMissPair), { now: NOW, mergeThreshold: 0.5 });
    expect(loose.merges.length).toBe(1);
  });
});

// ── AC 2a: corroboration — evidence crossing a threshold, history appended ────
describe("the corroboration transition (#1684, AC 2)", () => {
  it("an unverified claim at three DISTINCT evidence pointers crosses the default threshold", () => {
    const claims = [
      entry("warm.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/b.md", "memory-card/c.md"] })),
    ];
    const r = runLifecyclePass(claims, { now: NOW });
    expect(r.transitions).toEqual([
      {
        kind: "corroborate",
        file: "warm.md",
        from: "unverified",
        to: "corroborated",
        note: expect.stringContaining("3 distinct evidence pointers"),
      },
    ]);
    const claim = r.claims[0]!.claim;
    expect(claim.status).toBe("corroborated");
    const history = claim.history as { event: string; date: string }[];
    expect(history[history.length - 1]!.event).toBe("corroborated");
    expect(history[history.length - 1]!.date).toBe(NOW.toISOString());
    expect(validateClaim(claim).ok).toBe(true);
  });

  it("the fixture pass corroborates the triple-evidenced warm-start claim (dedupe runs first)", () => {
    const { claims } = loadRegistryClaims(LIFECYCLE_REGISTRY);
    const r = runLifecyclePass(claims, { now: NOW });
    expect(r.transitions.map((t) => `${t.file}:${t.kind}`).sort()).toEqual(["insight_warm_starts.md:corroborate"]);
    expect(r.findings).toEqual([]); // a clean fixture pass has no findings
  });

  it("repeated pointers count once; below-threshold claims stay unverified; the threshold is an option", () => {
    const stay = [
      entry("echo.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/a.md", "memory-card/a.md"] })),
      entry("pair.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/b.md"] })),
    ];
    const r = runLifecyclePass(stay, { now: NOW });
    expect(r.transitions).toEqual([]);
    expect(r.claims.every((c) => c.claim.status === "unverified")).toBe(true);

    const two = runLifecyclePass([entry("pair.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/b.md"] }))], {
      now: NOW,
      corroborateThreshold: 2,
    });
    expect(two.transitions.length).toBe(1);
    expect(CORROBORATE_THRESHOLD).toBe(3); // the pinned default
  });

  it("never re-stamps: corroborated stays corroborated, and the pass never demotes", () => {
    const r = runLifecyclePass(
      [entry("done.md", aClaim({ status: "corroborated", evidence: ["memory-card/a.md", "memory-card/b.md", "memory-card/c.md"] }))],
      { now: NOW },
    );
    expect(r.transitions).toEqual([]);
    // idempotence over its own output
    const first = runLifecyclePass([entry("warm.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/b.md", "memory-card/c.md"] }))], { now: NOW });
    expect(runLifecyclePass(first.claims, { now: NOW }).transitions).toEqual([]);
  });

  it("a merge can CARRY a claim over the threshold in the same pass (dedupe before corroboration)", () => {
    const claims = [
      entry("old.md", aClaim({
        statement: "STATE warm-starts beat control-only warm-starts across seeds",
        evidence: ["memory-card/a.md", "memory-card/b.md"],
        history: [{ date: "2026-06-01T00:00:00.000Z", event: "created", note: "older" }],
      })),
      entry("new.md", aClaim({
        statement: "STATE warm-starts beat control-only warm-starts across all seeds",
        evidence: ["memory-card/c.md"],
        history: [{ date: "2026-07-01T00:00:00.000Z", event: "created", note: "newer" }],
      })),
    ];
    const r = runLifecyclePass(claims, { now: NOW });
    expect(r.merges.length).toBe(1);
    const survivor = r.claims.find((c) => c.file === "old.md")!;
    expect(survivor.claim.status).toBe("corroborated"); // 3 accumulated pointers crossed it
    expect(r.transitions.map((t) => t.file)).toEqual(["old.md"]);
  });
});

// ── AC 2b: refutation — a contradicted-by-run signal, trail visible ────────────
describe("the refutation transition (#1684, AC 2)", () => {
  const signal: ContradictionSignal = {
    claim: "smooth.md",
    run: "r20260930-050350Z-51c7",
    note: "re-solve reproduced F=0.9999 with control-only warm-start",
  };

  it("a signal on an evidenced claim → refuted, with the run + reason visible in the appended history", () => {
    const r = runLifecyclePass([entry("smooth.md", aClaim({ evidence: ["memory-card/a.md"] }))], { now: NOW, signals: [signal] });
    expect(r.transitions).toEqual([
      { kind: "refute", file: "smooth.md", from: "unverified", to: "refuted", note: expect.stringContaining("r20260930-050350Z-51c7") },
    ]);
    const claim = r.claims[0]!.claim;
    expect(claim.status).toBe("refuted");
    const last = (claim.history as { event: string; note: string }[]).at(-1)!;
    expect(last.event).toBe("refuted");
    expect(last.note).toContain("r20260930-050350Z-51c7");
    expect(last.note).toContain("control-only warm-start");
    expect(validateClaim(claim).ok).toBe(true);
  });

  it("a CORROBORATED claim can be refuted (evidence-rich, later contradicted)", () => {
    const r = runLifecyclePass(
      [entry("smooth.md", aClaim({ status: "corroborated", evidence: ["memory-card/a.md", "memory-card/b.md"] }))],
      { now: NOW, signals: [signal] },
    );
    expect(r.transitions[0]!.from).toBe("corroborated");
    expect(r.claims[0]!.claim.status).toBe("refuted");
  });

  it("refutation wins over corroboration when both fire in one pass (a refuted claim is never corroborated)", () => {
    const r = runLifecyclePass(
      [entry("smooth.md", aClaim({ evidence: ["memory-card/a.md", "memory-card/b.md", "memory-card/c.md"] }))],
      { now: NOW, signals: [signal] },
    );
    expect(r.transitions.map((t) => t.kind)).toEqual(["refute"]);
    expect(r.claims[0]!.claim.status).toBe("refuted");
  });

  it("NEVER SILENT: unknown target, terminal claims, and zero-evidence refusals are named findings", () => {
    // distinct statements throughout — these four must NOT be dedupe candidates
    const r = runLifecyclePass(
      [
        entry("gone-target.md", aClaim({ statement: "an untouched evidenced claim", evidence: ["memory-card/a.md"] })),
        entry("already.md", aClaim({ statement: "an already refuted claim", status: "refuted", evidence: ["memory-card/a.md"] })),
        entry("replaced.md", aClaim({ statement: "an already superseded claim", status: "superseded", evidence: ["memory-card/a.md"] })),
        entry("bare.md", aClaim({ statement: "an unevidenced claim", evidence: [] })),
      ],
      {
        now: NOW,
        signals: [
          { claim: "no-such.md", run: "r1", note: "dangling" },
          signal, // smooth.md doesn't exist in this set — unknown target
          { claim: "already.md", run: "r2", note: "late" },
          { claim: "replaced.md", run: "r3", note: "late" },
          { claim: "bare.md", run: "r4", note: "nothing to refute against" },
        ],
      },
    );
    expect(r.transitions).toEqual([]); // nothing changed
    expect(r.findings.some((f) => f.includes("no-such.md") && f.includes("no such claim"))).toBe(true);
    expect(r.findings.some((f) => f.includes("smooth.md") && f.includes("no such claim"))).toBe(true);
    expect(r.findings.some((f) => f.includes("already.md") && f.includes("refuted"))).toBe(true);
    expect(r.findings.some((f) => f.includes("replaced.md") && f.includes("superseded"))).toBe(true);
    // zero-evidence refute is REFUSED, never a lint-violating registry
    expect(r.findings.some((f) => f.includes("bare.md") && f.includes("zero evidence"))).toBe(true);
    // no NEW refutation happened: every refute-able claim kept its status
    expect(r.claims.find((c) => c.file === "gone-target.md")!.claim.status).toBe("unverified");
    expect(r.claims.find((c) => c.file === "bare.md")!.claim.status).toBe("unverified");
  });

  it("a signal without a note still carries the run id in the trail", () => {
    const r = runLifecyclePass([entry("smooth.md", aClaim({ evidence: ["memory-card/a.md"] }))], {
      now: NOW,
      signals: [{ claim: "smooth.md", run: "r20261001-120000Z-aaaa" }],
    });
    expect((r.claims[0]!.claim.history as { note: string }[]).at(-1)!.note).toContain("r20261001-120000Z-aaaa");
  });
});

// ── AC 3: decay — unapplied beyond a window lands in the review queue; the
// queue PROPOSES, humans dispose (#1684 Key Decision: never an actor) ──────────
describe("the decay review queue (#1684, AC 3)", () => {
  it("the fixture pass queues exactly the long-unapplied pin-globals claim, age computed from last_applied", () => {
    const { claims } = loadRegistryClaims(LIFECYCLE_REGISTRY);
    const r = runLifecyclePass(claims, { now: NOW });
    expect(r.queue.length).toBe(1);
    const q = r.queue[0]!;
    expect(q.file).toBe("best_practice_pin_globals.md");
    expect(q.applied).toBe(2);
    expect(q.last_applied).toBe("2026-05-01T08:00:00.000Z");
    expect(q.age_days).toBe(154); // 2026-05-01 → 2026-10-02 at the fixture clock
    expect(q.reason).toContain("90"); // the window is named in the proposal
  });

  it("never-applied claims age from their newest lifecycle activity; fresh and recently-applied claims stay out", () => {
    // distinct statements throughout — these four must NOT be dedupe candidates
    const r = runLifecyclePass(
      [
        entry("never-old.md", aClaim({ statement: "a never-applied old claim", history: [{ date: "2026-01-01T00:00:00.000Z", event: "created", note: "x" }] })),
        entry("never-fresh.md", aClaim({ statement: "a never-applied fresh claim", history: [{ date: "2026-09-20T00:00:00.000Z", event: "created", note: "x" }] })),
        entry("recently-applied.md", aClaim({ statement: "a recently applied claim", applied: 3, last_applied: "2026-09-25T00:00:00.000Z" })),
        entry("stale-applied.md", aClaim({ statement: "a stale applied claim", applied: 3, last_applied: "2026-06-01T00:00:00.000Z" })),
      ],
      { now: NOW },
    );
    expect(r.queue.map((q) => q.file).sort()).toEqual(["never-old.md", "stale-applied.md"]);
    // the never-applied one ages from activity; the stale one from last_applied
    expect(r.queue.find((q) => q.file === "stale-applied.md")!.reason).toContain("since 2026-06-01");
    expect(r.queue.find((q) => q.file === "never-old.md")!.reason).toContain("never applied");
  });

  it("PROPOSAL ONLY: queueing mutates nothing — no status change, no history entry (humans dispose)", () => {
    const input = [entry("old.md", aClaim({ history: [{ date: "2026-01-01T00:00:00.000Z", event: "created", note: "x" }] }))];
    const r = runLifecyclePass(input, { now: NOW });
    expect(r.queue.length).toBe(1);
    expect(r.transitions).toEqual([]);
    expect(r.claims[0]!.claim).toEqual(input[0]!.claim); // byte-identical object
  });

  it("superseded and refuted claims never queue (terminal knowledge is out of the review economy)", () => {
    const r = runLifecyclePass(
      [
        entry("sup.md", aClaim({ status: "superseded", history: [{ date: "2026-01-01T00:00:00.000Z", event: "created", note: "x" }] })),
        entry("ref.md", aClaim({ status: "refuted", evidence: ["memory-card/a.md"], history: [{ date: "2026-01-01T00:00:00.000Z", event: "created", note: "x" }] })),
      ],
      { now: NOW },
    );
    expect(r.queue).toEqual([]);
  });

  it("a claim with no parseable timestamp is a named finding, never a guessed age", () => {
    const r = runLifecyclePass([entry("timeless.md", aClaim({ last_applied: null, history: [] }))], { now: NOW });
    expect(r.queue).toEqual([]);
    expect(r.findings.some((f) => f.includes("timeless.md") && f.includes("no parseable timestamp"))).toBe(true);
  });

  it("the window is a caller-tunable option (fixtures pin the default)", () => {
    expect(DECAY_WINDOW_DAYS).toBe(90);
    const claims = [entry("edge.md", aClaim({ history: [{ date: "2026-08-20T00:00:00.000Z", event: "created", note: "x" }] }))]; // 43 days before NOW
    expect(runLifecyclePass(claims, { now: NOW }).queue).toEqual([]);
    expect(runLifecyclePass(structuredClone(claims), { now: NOW, decayWindowDays: 30 }).queue.length).toBe(1);
  });

  it("the queue renders as the human proposal surface: generated-view header + one reviewable line per claim", () => {
    const { claims } = loadRegistryClaims(LIFECYCLE_REGISTRY);
    const r = runLifecyclePass(claims, { now: NOW });
    const text = renderQueueFile(r.queue, { now: NOW, windowDays: DECAY_WINDOW_DAYS });
    for (const needle of ["generated view", "amico claims lifecycle", "#1684", "never deletes", "never changes a status"])
      expect(text).toContain(needle);
    expect(text).toContain("[Pin the global model parameters before co-optimizing on a first solve](claims/best_practice_pin_globals.md)");
    expect(text).toContain("applied 2×");
    // every claim in the queue gets exactly one proposal line
    const bullets = text.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(r.queue.length);
  });

  it("the empty queue renders as an explicit nothing-to-review (a pass that ran is visible)", () => {
    const text = renderQueueFile([], { now: NOW, windowDays: DECAY_WINDOW_DAYS });
    expect(text).toContain("no claims beyond the");
    expect(text).toContain("90");
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toEqual([]);
  });
});

// ── the note-rewrite seam: frontmatter IS the claim object, prose is never touched ──
describe("rewriteClaimNote — the mutation write path (#1684)", () => {
  it("swaps EXACTLY the frontmatter for the updated claim, preserving the body byte-for-byte", () => {
    const raw = readFileSync(join(LIFECYCLE_REGISTRY, "insight_two_qubit_challenge.md"), "utf8");
    const updated = structuredClone(aClaim({ statement: "an updated statement", evidence: ["memory-card/x.md"] }));
    const out = rewriteClaimNote(raw, updated);
    // frontmatter parses back to EXACTLY the claim object
    const fm = parseFrontmatter(out);
    expect(fm.ok).toBe(true);
    if (fm.ok) expect(fm.data).toEqual(updated);
    // the body below the frontmatter is byte-identical to the original's
    const body = raw.slice(raw.indexOf("---\n", 3) + 4);
    expect(out.endsWith(body)).toBe(true);
  });
});
