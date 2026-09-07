// S2 (spec-20260907-011500 D2, issue #859): the plan's terminal artifact emits
// a structured `posture_recommendation` derived from the plan's ARTIFACT SHAPE
// — never keyword-guessed. Implementation-shaped (issues, PRs, code tasks) →
// develop; experiment-shaped (hypotheses, experiments, analysis) → research.
// Tie-breaks, each a named unit here:
//   - MIXED shape → ambiguous, BOTH modes named (the user picks; no silent
//     coin-flip);
//   - a spec whose executor is another agent recommends the EXECUTOR's
//     posture when determinable, else asks;
//   - an abandoned plan (no terminal execution artifact) never fires the
//     offer (kind "none").
// Pure over the compiled steps + the spec frontmatter, so every tie-break is
// testable without a planner subprocess.
import { describe, expect, it } from "vitest";
import {
  postureRecommendation,
  IMPLEMENTATION_TASK_TYPES,
  EXPERIMENT_TASK_TYPES,
  type PostureRecommendation,
} from "../src/posture_recommendation.js";
import type { CompiledStep } from "../src/plan_compile.js";
const step = (task_type: string, id = "s1"): CompiledStep => ({
  id,
  model: "anthropic/claude-opus-5",
  task_type,
});

const only = (r: PostureRecommendation): PostureRecommendation & { kind: "recommend" } =>
  r as PostureRecommendation & { kind: "recommend" };
const amb = (r: PostureRecommendation): PostureRecommendation & { kind: "ambiguous" } =>
  r as PostureRecommendation & { kind: "ambiguous" };

describe("posture recommendation — artifact shape", () => {
  it("classifies the task-type vocabulary into the two shapes (data, not keywords)", () => {
    // implementation-shaped: issues, PRs, code tasks, bookkeeping
    for (const t of ["implement-slice", "author-script", "bookkeeping"])
      expect(IMPLEMENTATION_TASK_TYPES).toContain(t);
    // experiment-shaped: hypotheses, experiments, analysis
    for (const t of ["experiment-sim", "experiment-hw", "insight"])
      expect(EXPERIMENT_TASK_TYPES).toContain(t);
    // the two shape sets are disjoint
    for (const t of IMPLEMENTATION_TASK_TYPES) expect(EXPERIMENT_TASK_TYPES).not.toContain(t);
  });

  it("recommends develop for an implementation-shaped plan", () => {
    const r = only(postureRecommendation([step("implement-slice"), step("bookkeeping", "s2")]));
    expect(r.kind).toBe("recommend");
    expect(r.mode).toBe("develop");
    expect(r.reason).toContain("implement-slice");
  });

  it("recommends research for an experiment-shaped plan", () => {
    const r = only(postureRecommendation([step("experiment-sim"), step("insight", "s2")]));
    expect(r.kind).toBe("recommend");
    expect(r.mode).toBe("research");
  });

  it("reason names the shape's task types, never prose keywords", () => {
    const r = only(postureRecommendation([step("author-script", "a"), step("implement-slice", "b")]));
    expect(r.reason).toContain("author-script");
    expect(r.reason).toContain("implement-slice");
  });

  it("administrative steps carry no shape on their own", () => {
    // triage/plan/review/converse shape nothing: a plan of only those has no
    // terminal execution artifact.
    for (const t of ["triage", "plan", "review", "converse"]) {
      const r = postureRecommendation([step(t)]);
      expect(r.kind).toBe("none");
    }
  });

  it("ignores administrative steps when a shaped step decides", () => {
    const r = only(postureRecommendation([step("plan", "p"), step("implement-slice", "x"), step("review", "r")]));
    expect(r.mode).toBe("develop");
  });
});

describe("posture recommendation — tie-breaks (spec D2 folds)", () => {
  it("MIXED shape → ambiguous with BOTH modes named — no silent coin-flip", () => {
    const r = amb(postureRecommendation([step("implement-slice"), step("experiment-sim", "s2")]));
    expect(r.kind).toBe("ambiguous");
    expect([...r.modes].sort()).toEqual(["develop", "research"]);
    expect(r.reason).toContain("implement-slice");
    expect(r.reason).toContain("experiment-sim");
  });

  it("a spec executor that resolves to a posture recommends the EXECUTOR's posture — shape notwithstanding", () => {
    const r = only(
      postureRecommendation([step("experiment-sim")], { executorAgent: "autodev" }),
    );
    expect(r.mode).toBe("develop");
  });

  it("the executor id resolves through the read-resolve alias table", () => {
    const r = only(postureRecommendation([step("implement-slice")], { executorAgent: "autoresearch" }));
    expect(r.mode).toBe("research");
  });

  it("current mode ids resolve too (develop/research are their own executors)", () => {
    expect(only(postureRecommendation([step("experiment-sim")], { executorAgent: "research" })).mode).toBe("research");
    expect(only(postureRecommendation([step("implement-slice")], { executorAgent: "develop" })).mode).toBe("develop");
  });

  it("an unresolvable executor → ambiguous (ask), never a guess", () => {
    const r = amb(postureRecommendation([step("implement-slice")], { executorAgent: "some-custom-agent" }));
    expect(r.kind).toBe("ambiguous");
    expect([...r.modes].sort()).toEqual(["develop", "research"]);
  });

  it("plan/build executors are NOT postures — the shape decides", () => {
    const r = only(postureRecommendation([step("experiment-sim")], { executorAgent: "plan" }));
    expect(r.mode).toBe("research");
    const r2 = only(postureRecommendation([step("implement-slice")], { executorAgent: "build" }));
    expect(r2.mode).toBe("develop");
  });

  it("an abandoned plan (no steps) never fires the offer", () => {
    const r = postureRecommendation([]);
    expect(r.kind).toBe("none");
    expect(r.reason).toMatch(/no terminal/i);
  });

  it("an administrative-only plan is an abandoned offer too", () => {
    const r = postureRecommendation([step("triage"), step("converse", "s2")], { executorAgent: "autodev" });
    // the executor hint cannot rescue a plan with no terminal artifact
    expect(r.kind).toBe("none");
  });
});

// ── the stamp: compilePlan emits posture_recommendation as DATA on the artifact ──

import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { designHash, validate } from "@amicode/schema";
import { compilePlan } from "../src/plan_compile.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import type { AgentOutcome } from "../src/agent_spawn.js";

const fmOf = (o: Record<string, unknown>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n---\n\nbody\n";

const ranPlanner = (payload: Record<string, unknown>) => async (): Promise<AgentOutcome> => ({
  status: "ran",
  model: "anthropic/claude-opus-5",
  variant: "high",
  findings: [],
  dropped_no_remedy: 0,
  payload,
});

const approvedReviewRow = (spec_id: string, design_hash: string): never =>
  ({
    type: "spec_review", ts: "t", spec_id, design_hash, rounds: 1,
    review_verdict: "approved", lens_registry_version: "1", lens_status: [],
    critics: [], findings_count: 0, blocking_count: 0, source: "user",
  }) as never;

describe("posture recommendation — the stamp on the compiled plan", () => {
  let dir: string;
  let plansDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "posture-stamp-"));
    plansDir = join(dir, "plans");
    mkdirSync(plansDir);
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  it("compilePlan stamps the recommendation on the artifact, the note, and the result — shape-derived", async () => {
    const spec = { schema_version: "1", spec_id: "spec-s2", task_type: "implement-slice", acceptance: ["x == 1"] };
    const raw = fmOf(spec);
    const design_hash = designHash(spec);
    const r = await compilePlan("spec.md", raw, {
      plansDir,
      records: [approvedReviewRow("spec-s2", design_hash)],
      runPlanner: ranPlanner({
        goal: "land the slice",
        steps: [
          { id: "a", model: "anthropic/claude-opus-5", task_type: "implement-slice" },
          { id: "b", model: "anthropic/claude-opus-5", task_type: "insight" },
        ],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.posture_recommendation.kind).toBe("ambiguous");

    // the artifact on disk carries the same field, and still validates
    const planText = readFileSync(r.plan_path, "utf8");
    const parsed = parseFrontmatter(planText);
    expect(parsed.ok).toBe(true);
    const planObj = (parsed as { data: Record<string, unknown> }).data;
    expect(planObj.posture_recommendation).toEqual(r.posture_recommendation);
    expect(validate(planObj, "plan").ok).toBe(true);

    // the note renders the AMBIGUOUS echo (data echoed, never re-derived)
    expect(planText).toContain("## Posture recommendation");
    expect(planText).toContain("AMBIGUOUS");
  });

  it("an implementation-shaped plan stamps kind recommend → develop and the note says so", async () => {
    const spec = { schema_version: "1", spec_id: "spec-s3", task_type: "implement-slice", acceptance: ["x == 1"] };
    const raw = fmOf(spec);
    const design_hash = designHash(spec);
    const r = await compilePlan("spec.md", raw, {
      plansDir,
      records: [approvedReviewRow("spec-s3", design_hash)],
      runPlanner: ranPlanner({
        goal: "ship it",
        steps: [{ id: "a", model: "anthropic/claude-opus-5", task_type: "author-script" }],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.posture_recommendation).toMatchObject({ kind: "recommend", mode: "develop" });
    const note = readFileSync(r.plan_path, "utf8");
    expect(note).toContain("`develop`");
    expect(existsSync(r.plan_path)).toBe(true);
  });
});
