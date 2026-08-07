// The spec-review runner (spec-20260728 §3).
// Plan: plan-20260728-104500 Task 10 (tier 1), plan-20260728-160000 Task 2 (tier 2).
//
// `reviewSpec` is ASYNC as of tier 2: critics run in parallel, which a sync spawn cannot do.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@amicode/schema";
import { readRecords, type SpecReviewRecord } from "../src/ledger.js";
import { reviewSpec, REVIEW_CEILING_MS } from "../src/spec_review.js";
import type { AgentOutcome } from "../src/agent_spawn.js";
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

/** A critic that ran and found nothing. */
const ran = (over: Partial<AgentOutcome> = {}): AgentOutcome => ({
  status: "ran", model: "anthropic/claude-opus-5", variant: "high", findings: [], dropped_no_remedy: 0, ...over,
});
/** A critic that could not deliver. `absent` means the mechanism was never there. */
const skip = (skip_class: "absent" | "failed", reason = "r"): AgentOutcome => ({
  status: "skipped", skip_class, reason, findings: [], dropped_no_remedy: 0,
});

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
    it("a clean spec with NO critic mechanism yields approved-mechanical, not approved", async () => {
      const r = await reviewSpec(specPath, fm(SLICE));
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.exit_code).toBe(0);
      expect(r.critics).toEqual([]);
    });

    it("a blocking tier-1 finding yields review_verdict=blocking and exit 65", async () => {
      const r = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["it should be good"] }));
      expect(r.review_verdict).toBe("blocking");
      expect(r.exit_code).toBe(65);
      expect(r.findings.some((f) => f.lens === "falsifiable" && f.severity === "blocking")).toBe(true);
    });

    it("blocking at the LAST round is `exhausted` (66), a human decision point", async () => {
      const r = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 3 });
      expect(r.review_verdict).toBe("exhausted");
      expect(r.exit_code).toBe(66);
    });

    it("an UNVERIFIED blocking lens cannot yield approved", async () => {
      const r = await reviewSpec(specPath, "no frontmatter here\n");
      expect(r.review_verdict).not.toBe("approved-mechanical");
      expect(r.exit_code).toBe(65);
      expect(r.findings[0].lens).toBe("schema");
    });

    it("a clean spec WITH critics that all run yields approved", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => ran() });
      expect(r.review_verdict).toBe("approved");
      expect(r.critics.length).toBeGreaterThan(0);
    });

    it("--offline runs tier 1 only and stamps critics: []", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { offline: true, spawnCritic: () => ran() });
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.critic_spawns).toBe(0);
      expect(record().critics).toEqual([]);
    });
  });

  // The distinction this describe block exists for is the one the shipped runner got wrong: it
  // keyed the verdict on `critics.length === 0`, so three critics that all TIMED OUT against a
  // working binary recorded "no critic binary available" — a false disclosure in the one field a
  // reader uses to judge whether the spec was reviewed at all.
  describe("approved-mechanical vs degraded turns on WHY there were no critics", () => {
    it("every critic ABSENT (no binary) → approved-mechanical: never adversarially reviewed", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => skip("absent", "binary not found") });
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.critics).toEqual([]);
    });

    it("a critic that TIMED OUT → degraded, NOT approved-mechanical", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => skip("failed", "no answer within 120000ms") });
      expect(r.review_verdict).toBe("degraded");
    });

    it("some ran, one failed → degraded", async () => {
      let n = 0;
      const r = await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => (n++ === 0 ? ran() : skip("failed")) });
      expect(r.review_verdict).toBe("degraded");
      expect(r.lens_status.some((s) => s.status === "skipped")).toBe(true);
    });

    it("each skipped tier-2 lens carries a non-empty reason IN THE PERSISTED RECORD", async () => {
      await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => skip("failed", "provider returned 503") });
      const skipped = record().lens_status.filter((s) => s.status === "skipped");
      expect(skipped.length).toBeGreaterThan(0);
      // Asserted on the ROW, not the return value: a reason that exists only in memory is a
      // reason nobody can read later.
      for (const s of skipped) expect(s.reason).toMatch(/503/);
    });
  });

  // 2026-08-06: a real review reported `approved-mechanical` with `critics: []` and NOTHING
  // else — no binary resolved, and the only evidence was a verdict string the reader had to
  // already know how to decode. An absent mechanism must name its own absence and its remedy.
  describe("an absent tier-2 mechanism says WHY — in the record, not just the verdict", () => {
    it("no binary resolved → every wanted tier-2 lens is skipped with a reason naming the fix", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { env: {} });
      expect(r.review_verdict).toBe("approved-mechanical");
      const skipped = r.lens_status.filter((s) => s.status === "skipped");
      expect(skipped.length).toBe(3); // wanted = min(--critics 3, 4 implement-slice lenses)
      for (const s of skipped) expect(s.reason).toMatch(/AMICO_CRITIC_BIN/);
      // …and the reason survives into the PERSISTED record, not just the return value.
      const persisted = record().lens_status.filter((s) => s.status === "skipped");
      expect(persisted.length).toBe(3);
      for (const s of persisted) expect(s.reason).toMatch(/AMICO_CRITIC_BIN/);
    });

    it("--offline says so rather than blaming the binary", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { offline: true, env: {} });
      const skipped = r.lens_status.filter((s) => s.status === "skipped");
      expect(skipped.length).toBe(3);
      for (const s of skipped) expect(s.reason).toMatch(/--offline/);
    });

    it("a RESOLVED mechanism leaves no spurious skip entries", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => ran(), env: {} });
      expect(r.review_verdict).toBe("approved");
      expect(r.lens_status.filter((s) => s.status === "skipped")).toEqual([]);
    });

    it("a tier-1-only task type gets no tier-2 skip noise", async () => {
      const r = await reviewSpec(specPath, fm({ ...SLICE, task_type: "converse" }), { env: {} });
      expect(r.review_verdict).toBe("approved-mechanical");
      expect(r.lens_status.filter((s) => s.status === "skipped")).toEqual([]);
    });
  });

  describe("the free-tier guarantee", () => {
    it("spawns ZERO critics when a tier-1 lens blocks", async () => {
      let spawns = 0;
      const r = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), {
        spawnCritic: () => { spawns++; return ran(); },
      });
      expect(r.exit_code).toBe(65);
      expect(spawns).toBe(0); // a bad spec never reaches a paid critic
      expect(r.critic_spawns).toBe(0);
    });

    it("…and the POSITIVE CONTROL: the same mechanism DOES spawn on a clean spec", async () => {
      // Without this, the guarantee above is unobservable — `spawns` is 0 for every input when
      // no binary resolves, so a broken wiring would pass the negative test silently.
      let spawns = 0;
      await reviewSpec(specPath, fm(SLICE), { spawnCritic: () => { spawns++; return ran(); } });
      // 3, not 4: implement-slice HAS 4 tier-2 lenses but `--critics` defaults to 3, so the
      // default review spends three calls and the fourth lens is simply not selected.
      expect(spawns).toBe(3);
    });

    it("spawns ZERO critics for a tier-1-only task type however many are requested", async () => {
      let spawns = 0;
      await reviewSpec(specPath, fm({ ...SLICE, task_type: "bookkeeping" }), {
        critics: 3, spawnCritic: () => { spawns++; return ran(); },
      });
      expect(spawns).toBe(0);
    });

    it("clamps --critics to the lenses that exist for this task type", async () => {
      let spawns = 0;
      await reviewSpec(specPath, fm(SLICE), { critics: 99, spawnCritic: () => { spawns++; return ran(); } });
      expect(spawns).toBe(4);
    });
  });

  describe("tier 2 runs in PARALLEL", () => {
    it("two critics' [enter, exit] intervals INTERSECT", async () => {
      // The claim is about wall clock, so it is asserted on wall clock. A sync spawn cannot pass
      // this — which is why the mechanism is async `spawn` rather than `spawnSync`.
      const spans: Array<[number, number]> = [];
      await reviewSpec(specPath, fm(SLICE), {
        spawnCritic: async () => {
          const enter = Date.now();
          await new Promise((r) => setTimeout(r, 80));
          spans.push([enter, Date.now()]);
          return ran();
        },
      });
      expect(spans.length).toBe(3); // the default --critics

      const [a, b] = spans;
      expect(a[0]).toBeLessThan(b[1]);
      expect(b[0]).toBeLessThan(a[1]); // genuine overlap, not merely "both finished"
    });

    it("the whole-review ceiling stops spawning further critics", async () => {
      // The ceiling needs an INJECTED clock to be testable at all: per-critic timeout is 120s
      // and the largest lens set is 4, so a parallel review's worst case is ~120s and real time
      // could never reach 600s. An untestable ceiling is a comment, not a guarantee.
      let spawns = 0;
      let elapsed = 0;
      const r = await reviewSpec(specPath, fm(SLICE), {
        elapsedMs: () => elapsed,
        spawnCritic: () => { spawns++; elapsed = REVIEW_CEILING_MS; return ran(); },
      });
      expect(spawns).toBe(1); // the first spawn pushes elapsed past the ceiling
      expect(r.review_verdict).toBe("degraded"); // the unspawned lenses are skipped, not clean
      expect(record().lens_status.filter((s) => s.status === "skipped").length).toBe(2);
    });

    it("checks the ceiling BEFORE each spawn, so it bounds spend and not just wall time", async () => {
      let elapsed = REVIEW_CEILING_MS;
      let spawns = 0;
      await reviewSpec(specPath, fm(SLICE), {
        elapsedMs: () => elapsed, spawnCritic: () => { spawns++; return ran(); },
      });
      expect(spawns).toBe(0);
    });
  });

  describe("the model stamp is a fact, not a request", () => {
    it("stamps the model the CHILD reported, not the one we asked for", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), {
        spawnCritic: () => ran({ model: "anthropic/claude-haiku-4-5", variant: "low" }),
      });
      expect(r.critics[0]).toEqual({ model: "anthropic/claude-haiku-4-5", variant: "low" });
      expect(record().critics[0].model).toBe("anthropic/claude-haiku-4-5");
    });
  });

  describe("THE TERMINATION INVARIANT", () => {
    const blockingFinding = (lens: string): Finding => ({
      lens, severity: "blocking", claim: "c", evidence: "e", remedy: "r", round: 1,
    });

    it("a tier-2 `blocking` finding on any lens but `contradiction` is DOWNGRADED to advisory", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), {
        spawnCritic: (lens) => ran({ findings: lens === "hidden-failure" ? [blockingFinding("hidden-failure")] : [] }),
      });
      expect(r.findings.filter((f) => f.severity === "blocking")).toEqual([]);
      expect(r.blocking_count).toBe(0);
      expect(r.review_verdict).toBe("approved");
      // Asserted on the PERSISTED sidecar: an implementation that wrote `blocking` to disk and
      // downgraded only the in-memory copy would pass an assertion on the return value.
      const persisted: Finding[] = JSON.parse(readFileSync(r.findings_ref, "utf8"));
      expect(persisted.find((f) => f.lens === "hidden-failure")?.severity).toBe("advisory");
      expect(record().blocking_count).toBe(0);
    });

    it("`contradiction` is the ONE tier-2 finding that may block", async () => {
      const r = await reviewSpec(specPath, fm(SLICE), {
        spawnCritic: (lens) => ran({ findings: lens === "hidden-failure" ? [blockingFinding("contradiction")] : [] }),
      });
      expect(r.blocking_count).toBe(1);
      expect(r.exit_code).toBe(65);
    });
  });

  describe("the findings sidecar", () => {
    it("writes the bodies, and findings_sha256 is over the CANONICAL array", async () => {
      const r = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }));
      expect(existsSync(r.findings_ref)).toBe(true);
      const bodies: Finding[] = JSON.parse(readFileSync(r.findings_ref, "utf8"));
      expect(bodies).toHaveLength(r.findings_count);
      expect(createHash("sha256").update(canonicalJson(bodies as never), "utf8").digest("hex")).toBe(r.findings_sha256);
    });

    it("keys the sidecar on spec_id AND round, so round 2 cannot overwrite round 1", async () => {
      const a = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 1 });
      const b = await reviewSpec(specPath, fm({ ...SLICE, acceptance: ["prose"] }), { round: 2 });
      expect(a.findings_ref).not.toBe(b.findings_ref);
      expect(existsSync(a.findings_ref)).toBe(true);
    });

    it("a sidecar that cannot be written fails LOUDLY, never a dangling ref", async () => {
      chmodSync(dir, 0o500);
      try {
        await expect(reviewSpec(specPath, fm(SLICE))).rejects.toThrow(/sidecar/i);
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it("the record stays under PIPE_BUF with a maximal review", async () => {
      const many = Array.from({ length: 40 }, (_, i) => `metric${i} >= ${i}`);
      const r = await reviewSpec(specPath, fm({ ...SLICE, acceptance: many }), {
        spawnCritic: () => ran({
          findings: Array.from({ length: 9 }, (_, i) => ({
            lens: "hidden-failure", severity: "advisory" as const,
            claim: "c".repeat(200), evidence: "e".repeat(200), remedy: "r".repeat(200), round: 1 + (i % 3),
          })),
        }),
      });
      const line = readFileSync(process.env.AMICO_LEDGER!, "utf8").split("\n").filter(Boolean).pop()!;
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096);
      // 3 critics x 9 findings, each ~600 bytes of prose: >15 KB of bodies in the sidecar while
      // the ROW stays under the 4096-byte ceiling. That gap is the whole reason the sidecar
      // exists — the row used to carry every finding and would have thrown on append, after the
      // model spend.
      expect(r.findings_count).toBe(27);
      expect(Buffer.byteLength(readFileSync(r.findings_ref, "utf8"), "utf8")).toBeGreaterThan(15_000);
    });
  });

  describe("the ledger record", () => {
    it("appends exactly one spec_review, stamped with the registry version", async () => {
      await reviewSpec(specPath, fm(SLICE));
      expect(readRecords().filter((r) => r.type === "spec_review")).toHaveLength(1);
      expect(record().lens_registry_version).toMatch(/^\S+$/);
      expect(record().design_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("records per-lens status including not-applicable", async () => {
      await reviewSpec(specPath, fm(SLICE));
      expect(record().lens_status.find((s) => s.lens === "budget")).toBeUndefined();
      expect(record().lens_status.map((s) => s.lens)).toContain("schema");
    });

    it("a launch-shaped spec records budget/baseline/precedent statuses", async () => {
      await reviewSpec(specPath, fm(LAUNCH));
      const names = record().lens_status.map((s) => s.lens);
      expect(names).toContain("budget");
      expect(names).toContain("baseline");
      expect(record().lens_status.find((s) => s.lens === "precedent")?.status).toBe("not-applicable");
    });

    it("append can be suppressed for pure computation", async () => {
      await reviewSpec(specPath, fm(SLICE), { append: false });
      expect(readRecords().filter((r) => r.type === "spec_review")).toHaveLength(0);
    });
  });

  // A-11: with `opencode` on PATH, any test omitting --offline and injecting nothing would fan
  // out real billed critics. test/setup.ts pins $AMICO_CRITIC_BIN to an impossible path for the
  // whole suite; this asserts the guard is actually in force rather than assumed.
  describe("the no-real-model-calls guard", () => {
    it("the suite-wide $AMICO_CRITIC_BIN cannot resolve", async () => {
      expect(process.env.AMICO_CRITIC_BIN).toMatch(/nonexistent/);
      const r = await reviewSpec(specPath, fm(SLICE));
      expect(r.critic_spawns).toBe(0);
      expect(r.review_verdict).toBe("approved-mechanical");
    });

    it("resolves a REAL child when a test opts in explicitly", async () => {
      // The mechanism is wired end to end — not merely injectable — and the opt-in is visible.
      const r = await reviewSpec(specPath, fm(SLICE), {
        env: { ...process.env, AMICO_CRITIC_BIN: undefined } as NodeJS.ProcessEnv,
        spawnCritic: () => ran(),
      });
      expect(r.critics.length).toBe(3);
    });
  });
});

// Keeps `spawn` imported: the parallel test above relies on the async mechanism, and a stray
// unused-import cleanup would silently make it a sequential test that still passes.
void spawn;
