// The spec-review runner (spec-20260728 §3).
// Plan: plan-20260728-104500 Task 10.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@amicode/schema";
import { readRecords, type SpecReviewRecord } from "../src/ledger.js";
import { reviewSpec } from "../src/spec_review.js";
import type { Finding } from "../src/lenses.js";

const fm = (o: Record<string, unknown>) =>
  "---\n" +
  Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n") +
  "\n---\n\nbody\n";

const LAUNCH = {
  schema_version: '"1"', spec_id: "spec-launch", task_type: "experiment-sim",
  acceptance: ["F_rolled >= 0.999"], budget: { max_solves: 8, tier: "free" },
  baseline: { value: 0.968, source: "published" },
};
const SLICE = { schema_version: '"1"', spec_id: "spec-slice", task_type: "implement-slice", acceptance: ["x == 1"] };

const record = () => readRecords().filter((r): r is SpecReviewRecord => r.type === "spec_review")[0];

describe("reviewSpec", () => {
  let dir: string;
  let specPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-review-"));
    specPath = join(dir, "spec.md");
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  describe("verdicts", () => {
    it("a clean spec with NO critic mechanism yields approved-mechanical, not approved", () => {
      const r = reviewSpec(specPath, fm(SLICE));
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.exit_code).toBe(0);
      expect(r.critics).toEqual([]);
    });

    it("a blocking tier-1 finding yields review_verdict=blocking and exit 65", () => {
      const r = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["it should be good"] }));
      expect(r.review_verdict).toBe("blocking");
      expect(r.exit_code).toBe(65);
      expect(r.findings.some((f) => f.lens === "falsifiable" && f.severity === "blocking")).toBe(true);
    });

    it("blocking at the LAST round is `exhausted` (66), a human decision point", () => {
      const r = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 3 });
      expect(r.review_verdict).toBe("exhausted");
      expect(r.exit_code).toBe(66);
    });

    it("an UNVERIFIED blocking lens cannot yield approved", () => {
      // `precedent` is advisory, so force the case through a blocking lens: an
      // unreadable frontmatter is the schema lens failing to run at all.
      const r = reviewSpec(specPath, "no frontmatter here\n");
      expect(r.review_verdict).not.toBe("approved-mechanical");
      expect(r.exit_code).toBe(65);
      expect(r.findings[0].lens).toBe("schema");
    });

    it("a clean spec WITH critics that all run yields approved", () => {
      const r = reviewSpec(specPath, fm(SLICE), {
        spawnCritic: () => ({ model: "anthropic/claude-opus-5", variant: "high", findings: [] }),
      });
      expect(r.review_verdict).toBe("approved");
      expect(r.critics.length).toBeGreaterThan(0);
    });

    it("a critic that returns nothing (timeout/unparseable) yields DEGRADED, never approved", () => {
      let n = 0;
      const r = reviewSpec(specPath, fm(SLICE), {
        spawnCritic: () => (n++ === 0 ? { model: "anthropic/claude-opus-5", variant: "high", findings: [] } : undefined),
      });
      expect(r.review_verdict).toBe("degraded");
      expect(r.lens_status.some((s) => s.status === "skipped")).toBe(true);
    });

    it("--offline runs tier 1 only and stamps critics: []", () => {
      const r = reviewSpec(specPath, fm(SLICE), {
        offline: true,
        spawnCritic: () => ({ model: "anthropic/claude-opus-5", variant: "high", findings: [] }),
      });
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.critic_spawns).toBe(0);
      expect(record().critics).toEqual([]);
    });
  });

  describe("the free-tier guarantee", () => {
    it("spawns ZERO critics when a tier-1 lens blocks", () => {
      let spawns = 0;
      const r = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), {
        spawnCritic: () => { spawns++; return { model: "anthropic/claude-opus-5", variant: "high", findings: [] }; },
      });
      expect(r.exit_code).toBe(65);
      expect(spawns).toBe(0); // a bad spec never reaches a paid critic
      expect(r.critic_spawns).toBe(0);
    });

    it("spawns ZERO critics for a tier-1-only task type however many are requested", () => {
      let spawns = 0;
      reviewSpec(specPath, fm({ ...SLICE, task_type: "bookkeeping" }), {
        critics: 3,
        spawnCritic: () => { spawns++; return { model: "anthropic/claude-opus-5", variant: "high", findings: [] }; },
      });
      expect(spawns).toBe(0);
    });

    it("clamps --critics to the lenses that exist for this task type", () => {
      let spawns = 0;
      reviewSpec(specPath, fm(SLICE), {
        critics: 99,
        spawnCritic: () => { spawns++; return { model: "anthropic/claude-opus-5", variant: "high", findings: [] }; },
      });
      expect(spawns).toBe(4); // implement-slice has 4 tier-2 lenses
    });
  });

  describe("THE TERMINATION INVARIANT", () => {
    const blockingFinding = (lens: string): Finding => ({
      lens, severity: "blocking", claim: "c", evidence: "e", remedy: "r", round: 1,
    });

    it("a tier-2 `blocking` finding on any lens but `contradiction` is DOWNGRADED to advisory", () => {
      const r = reviewSpec(specPath, fm(SLICE), {
        spawnCritic: (lens) => ({
          model: "anthropic/claude-opus-5", variant: "high",
          findings: lens === "hidden-failure" ? [blockingFinding("hidden-failure")] : [],
        }),
      });
      // Persisted as ADVISORY, and the review is not blocked by it.
      expect(r.findings.filter((f) => f.severity === "blocking")).toEqual([]);
      expect(r.blocking_count).toBe(0);
      expect(r.review_verdict).toBe("approved");
      const persisted: Finding[] = JSON.parse(readFileSync(r.findings_ref, "utf8"));
      expect(persisted.find((f) => f.lens === "hidden-failure")?.severity).toBe("advisory");
      expect(record().blocking_count).toBe(0);
    });

    it("`contradiction` is the ONE tier-2 finding that may block", () => {
      const r = reviewSpec(specPath, fm(SLICE), {
        spawnCritic: (lens) => ({
          model: "anthropic/claude-opus-5", variant: "high",
          findings: lens === "hidden-failure" ? [blockingFinding("contradiction")] : [],
        }),
      });
      expect(r.blocking_count).toBe(1);
      expect(r.exit_code).toBe(65);
    });
  });

  describe("the findings sidecar", () => {
    it("writes the bodies, and findings_sha256 is over the CANONICAL array", () => {
      const r = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }));
      expect(existsSync(r.findings_ref)).toBe(true);
      const bodies: Finding[] = JSON.parse(readFileSync(r.findings_ref, "utf8"));
      expect(bodies).toHaveLength(r.findings_count);
      expect(createHash("sha256").update(canonicalJson(bodies as never), "utf8").digest("hex")).toBe(r.findings_sha256);
    });

    it("keys the sidecar on spec_id AND round, so round 2 cannot overwrite round 1", () => {
      const a = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 1 });
      const b = reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 2 });
      expect(a.findings_ref).not.toBe(b.findings_ref);
      expect(existsSync(a.findings_ref)).toBe(true);
    });

    it("a sidecar that cannot be written fails LOUDLY, never a dangling ref", () => {
      chmodSync(dir, 0o500); // read+execute only: no new subdirectory
      try {
        expect(() => reviewSpec(specPath, fm(SLICE))).toThrow(/sidecar/i);
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it("the record stays under PIPE_BUF with a maximal review", () => {
      const many = Array.from({ length: 40 }, (_, i) => `metric${i} >= ${i}`);
      const r = reviewSpec(specPath, fm({ ...SLICE, acceptance: many }), {
        spawnCritic: () => ({
          model: "anthropic/claude-opus-5", variant: "high",
          findings: Array.from({ length: 9 }, (_, i) => ({
            lens: "hidden-failure", severity: "advisory" as const,
            claim: "c".repeat(200), evidence: "e".repeat(200), remedy: "r".repeat(200), round: 1 + (i % 3),
          })),
        }),
      });
      const line = readFileSync(process.env.AMICO_LEDGER!, "utf8").split("\n").filter(Boolean).pop()!;
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096);
      // 3 critics (the default) x 9 findings, each ~600 bytes of prose: >15 KB of bodies
      // in the sidecar while the ROW stays under the 4096-byte ceiling. That gap is the
      // whole reason the sidecar exists — the row used to carry every finding and would
      // have thrown on append, after the model spend.
      expect(r.findings_count).toBe(27);
      expect(Buffer.byteLength(readFileSync(r.findings_ref, "utf8"), "utf8")).toBeGreaterThan(15_000);
    });
  });

  describe("the ledger record", () => {
    it("appends exactly one spec_review, stamped with the registry version", () => {
      reviewSpec(specPath, fm(SLICE));
      const recs = readRecords().filter((r) => r.type === "spec_review");
      expect(recs).toHaveLength(1);
      expect(record().lens_registry_version).toMatch(/^\S+$/);
      expect(record().design_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("records per-lens status including not-applicable", () => {
      reviewSpec(specPath, fm(SLICE));
      const budget = record().lens_status.find((s) => s.lens === "budget");
      // implement-slice is not launch-shaped, so budget is scoped out — and that is
      // recorded as not-applicable rather than absent or clean.
      expect(budget).toBeUndefined(); // not even selected for this task type
      expect(record().lens_status.map((s) => s.lens)).toContain("schema");
    });

    it("a launch-shaped spec records budget/baseline/precedent statuses", () => {
      reviewSpec(specPath, fm(LAUNCH));
      const names = record().lens_status.map((s) => s.lens);
      expect(names).toContain("budget");
      expect(names).toContain("baseline");
      expect(record().lens_status.find((s) => s.lens === "precedent")?.status).toBe("not-applicable");
    });

    it("append can be suppressed for pure computation", () => {
      reviewSpec(specPath, fm(SLICE), { append: false });
      expect(readRecords().filter((r) => r.type === "spec_review")).toHaveLength(0);
    });
  });
});
