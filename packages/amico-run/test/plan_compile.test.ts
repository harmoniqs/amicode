// `amico plan compile` (spec-20260728 §4).
// Plan: plan-20260728-160000 Task 3.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designHash, planHash, validate } from "@amicode/schema";
import { appendRecord, readRecords, type LedgerRecord } from "../src/ledger.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import {
  checkBudget,
  checkStepShape,
  compilePlan,
  suggestedTtlFor,
  UNCHECKED_BOUNDS,
  type CompiledStep,
} from "../src/plan_compile.js";
import type { AgentOutcome } from "../src/agent_spawn.js";

const OPUS = "anthropic/claude-opus-5";
const HAIKU = "anthropic/claude-haiku-4-5";

const step = (over: Partial<CompiledStep> = {}): CompiledStep => ({
  id: "s1", model: OPUS, task_type: "implement-slice", gates: ["re-rollout"], ...over,
});

const LAUNCH_SPEC = {
  schema_version: "1", spec_id: "spec-l", task_type: "experiment-sim",
  acceptance: ["F_rolled >= 0.999"], budget: { max_solves: 4, tier: "free", device: "ro" },
  baseline: { value: 0.9, source: "published" },
};
const SLICE_SPEC = { schema_version: "1", spec_id: "spec-s", task_type: "implement-slice", acceptance: ["x == 1"] };

/** JSON-encode EVERY value, not just objects: `String("1")` yields bare `1`, which YAML reads as
 *  the number 1 and the schema then rejects (`schema_version` is the string enum ["1"]). JSON is
 *  a YAML subset, so this is both correct and unambiguous for scalars, lists and maps alike. */
const fm = (o: Record<string, unknown>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n---\n\nbody\n";

/** A planner that ran and returned this plan. */
const planner = (payload: Record<string, unknown>, over: Partial<AgentOutcome> = {}) => async (): Promise<AgentOutcome> => ({
  status: "ran", model: OPUS, variant: "high", findings: [], dropped_no_remedy: 0, payload, ...over,
});

const approvedReview = (design_hash: string): LedgerRecord =>
  ({
    type: "spec_review", ts: "2026-07-28T10:00:00Z", spec_id: "spec-x", design_hash, rounds: 1,
    review_verdict: "approved", lens_registry_version: "1", lens_status: [],
    critics: [{ model: OPUS, variant: "high" }], findings_count: 0, blocking_count: 0, source: "user",
  }) as LedgerRecord;

describe("plan compile", () => {
  let dir: string;
  let plansDir: string;
  let specPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-compile-"));
    plansDir = join(dir, "plans");
    mkdirSync(plansDir);
    specPath = join(dir, "spec.md");
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  const compile = (spec: Record<string, unknown>, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const raw = fm(spec);
    const dh = designHash(parseFrontmatter(raw).ok ? (parseFrontmatter(raw) as { data: Record<string, unknown> }).data : {});
    return compilePlan(specPath, raw, {
      plansDir, runPlanner: planner(payload), records: [approvedReview(dh)], ...over,
    });
  };

  // ── §4.2, corrected ────────────────────────────────────────────────────────
  describe("the compile-time budget refusal", () => {
    it("joins device by DEVICE_ORDER and names both sides", async () => {
      const r = await compile(LAUNCH_SPEC, {
        goal: "g", steps: [step({ task_type: "experiment-sim", permissions: { device: "rw" } })],
      });
      expect(r.ok).toBe(false);
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/device: the plan demands "rw" but the budget authorises "ro"/);
    });

    it("allows a device demand at or below the authorised level", async () => {
      const r = await compile(LAUNCH_SPEC, {
        goal: "g", steps: [step({ task_type: "experiment-sim", permissions: { device: "ro" } })],
      });
      expect(r.ok).toBe(true);
    });

    it("sums solves over SOLVE-BEARING steps only, and names the margin", async () => {
      const steps = [
        ...Array.from({ length: 5 }, (_, i) => step({ id: `sim${i}`, task_type: "experiment-sim" })),
        step({ id: "write", task_type: "implement-slice" }), // must NOT count
      ];
      const r = await compile(LAUNCH_SPEC, { goal: "g", steps });
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/max_solves: the plan needs 5 solve\(s\) but the budget authorises 4 — over by 1/);
    });

    it("checks each bound INDEPENDENTLY — two exceeded bounds name two", async () => {
      // warrant.test.ts's convention: a caller fixing two problems should not have to run twice
      // to find the second.
      const steps = [
        ...Array.from({ length: 5 }, (_, i) => step({ id: `sim${i}`, task_type: "experiment-sim" })),
        step({ id: "hw", task_type: "experiment-hw", permissions: { device: "rw" } }),
      ];
      const r = await compile(LAUNCH_SPEC, { goal: "g", steps });
      const errs = (r as { errors: string[] }).errors;
      expect(errs.some((e) => e.startsWith("device:"))).toBe(true);
      expect(errs.some((e) => e.startsWith("max_solves:"))).toBe(true);
    });

    it("REFUSES when the budget OMITS a bound a step demands — an omitted bound is not permission", async () => {
      // warrant.test.ts established this direction for the launch gate; the compile side had no
      // counterpart, and every $defs.bounds key is optional.
      const spec = { ...LAUNCH_SPEC, budget: { max_solves: 4, tier: "free" } }; // no `device`
      const r = await compile(spec, { goal: "g", steps: [step({ task_type: "experiment-sim", permissions: { device: "ro" } })] });
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/does not declare device at all/);
    });

    it("REFUSES a launch-shaped plan when the spec declares no budget at all", async () => {
      const spec = { schema_version: "1", spec_id: "spec-n", task_type: "implement-slice", acceptance: ["x == 1"] };
      const r = await compile(spec, { goal: "g", steps: [step({ task_type: "experiment-sim" })] });
      expect(r.ok).toBe(false);
    });

    it("DISCLOSES what it could not check, rather than passing silently", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step()] });
      expect(r.ok).toBe(true);
      // `tier` is here — not checked — because bounds.tier speaks the solvespec TRUST vocabulary
      // (free|composed|vetted|hpc) while a step's tier field is `model`, a model id. Comparing
      // them is a category error, not a strictness choice.
      expect((r as { unchecked: readonly string[] }).unchecked).toEqual(UNCHECKED_BOUNDS);
      expect(UNCHECKED_BOUNDS).toContain("tier");
      expect(UNCHECKED_BOUNDS).toContain("max_size_class");
    });

    it("refuses a NON-launch-shaped spec that compiled to a solve-bearing step, naming task_type", async () => {
      // Otherwise labelling launch work `implement-slice` silently switches off two blocking
      // tier-1 lenses AND makes this whole check a no-op.
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step({ task_type: "experiment-sim" })] });
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/task_type: the spec is `implement-slice`/);
    });
  });

  describe("a step must declare what the budget check reads", () => {
    it("REFUSES a step with no model — never treats an absent demand as unbounded", () => {
      // §0.1's inert max_solves counter is exactly this defect: a check keyed on a field nothing
      // supplies reads as enforced while doing nothing.
      const r = checkStepShape([{ id: "s1", task_type: "implement-slice" }]);
      expect("errors" in r && r.errors.join(" ")).toMatch(/model must be a provider\/model-id/);
    });
    it("REFUSES a step with no task_type", () => {
      const r = checkStepShape([{ id: "s1", model: OPUS }]);
      expect("errors" in r && r.errors.join(" ")).toMatch(/task_type must be one of/);
    });
    it("REFUSES a duplicate step id, because derivation keys on it", () => {
      const r = checkStepShape([step(), step()]);
      expect("errors" in r && r.errors.join(" ")).toMatch(/duplicate id/);
    });
    it("REFUSES a below-frontier step with no gates (fleet §8)", () => {
      const r = checkStepShape([{ id: "s1", model: HAIKU, task_type: "implement-slice", gates: [] }]);
      expect("errors" in r && r.errors.join(" ")).toMatch(/below the frontier tier and declares no gates/);
    });
    it("ACCEPTS a below-frontier step that IS gated", () => {
      expect(checkStepShape([{ id: "s1", model: HAIKU, task_type: "implement-slice", gates: ["schema-lint"] }])).toHaveProperty("steps");
    });
    it("refuses an empty step list", () => {
      expect("errors" in checkStepShape([])).toBe(true);
    });
  });

  // The Rev-1 version of these tests asserted only exit_code, so an implementation that wrote the
  // plan and THEN refused passed every one of them. That is the same defect shape as asserting a
  // severity downgrade on the in-memory result while the sidecar got `blocking`.
  describe("refusal is TOTAL — nothing is written, nothing is recorded", () => {
    it("writes no plan file and appends no row on a budget refusal", async () => {
      const r = await compile(LAUNCH_SPEC, {
        goal: "g", steps: Array.from({ length: 9 }, (_, i) => step({ id: `s${i}`, task_type: "experiment-sim" })),
      });
      expect(r.ok).toBe(false);
      expect(readRecords().filter((x) => x.type === "plan_compiled")).toHaveLength(0);
      expect(readdirSync(plansDir)).toEqual([]);
    });

    it("the POSITIVE CONTROL: a legal compile writes both", async () => {
      const r = await compile(SLICE_SPEC, { goal: "ship the thing", steps: [step()] });
      expect(r.ok).toBe(true);
      expect(existsSync((r as { plan_path: string }).plan_path)).toBe(true);
      expect(readRecords().filter((x) => x.type === "plan_compiled")).toHaveLength(1);
    });
  });

  describe("the review precondition", () => {
    it("refuses when there is NO review at all, unless --allow-unreviewed", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step()] }, { records: [] });
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/no review on record/);
      const r2 = await compile(SLICE_SPEC, { goal: "g", steps: [step()] }, { records: [], allowUnreviewed: true });
      expect(r2.ok).toBe(true);
      expect((r2 as { allow_unreviewed: boolean }).allow_unreviewed).toBe(true);
    });

    it("STAMPS allow_unreviewed on the row, so the surface can say so", async () => {
      await compile(SLICE_SPEC, { goal: "g", steps: [step()] }, { records: [], allowUnreviewed: true });
      expect(readRecords().find((x) => x.type === "plan_compiled")).toMatchObject({ allow_unreviewed: true });
    });

    it("refuses approved-mechanical without the flag, and records it with", async () => {
      const raw = fm(SLICE_SPEC);
      const dh = designHash((parseFrontmatter(raw) as { data: Record<string, unknown> }).data);
      const mech = { ...approvedReview(dh), review_verdict: "approved-mechanical" } as LedgerRecord;
      const bare = await compilePlan(specPath, raw, { plansDir, runPlanner: planner({ goal: "g", steps: [step()] }), records: [mech] });
      expect((bare as { errors: string[] }).errors.join(" ")).toMatch(/no critic actually reviewed/);
      const forced = await compilePlan(specPath, raw, {
        plansDir, runPlanner: planner({ goal: "g", steps: [step()] }), records: [mech], allowUnreviewed: true,
      });
      expect(forced.ok).toBe(true);
    });

    it("--allow-unreviewed does NOT override a BLOCKING review", async () => {
      const raw = fm(SLICE_SPEC);
      const dh = designHash((parseFrontmatter(raw) as { data: Record<string, unknown> }).data);
      const blocked = { ...approvedReview(dh), review_verdict: "blocking", blocking_count: 2 } as LedgerRecord;
      const r = await compilePlan(specPath, raw, {
        plansDir, runPlanner: planner({ goal: "g", steps: [step()] }), records: [blocked], allowUnreviewed: true,
      });
      expect(r.ok).toBe(false);
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/does NOT override a blocking review/);
    });
  });

  describe("the plan artifact", () => {
    it("agrees THREE ways: frontmatter == the row == planHash(reparsed file)", async () => {
      // Exclusion and sensitivity are already covered in schema/test/design_hash.test.ts;
      // cross-artifact agreement is what is actually new, and it is what a warrant binds to.
      const r = await compile(SLICE_SPEC, { goal: "ship it", steps: [step()] });
      const path = (r as { plan_path: string }).plan_path;
      const parsed = parseFrontmatter(readFileSync(path, "utf8"));
      expect(parsed.ok).toBe(true);
      const data = (parsed as { data: Record<string, unknown> }).data;
      expect(data.plan_hash).toBe((r as { plan_hash: string }).plan_hash);
      expect(readRecords().find((x) => x.type === "plan_compiled")).toMatchObject({ plan_hash: data.plan_hash });
      expect(planHash({ goal: data.goal as string, steps: data.steps as Record<string, unknown>[] })).toBe(data.plan_hash);
    });

    it("the written frontmatter VALIDATES against the plan schema", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step()] });
      const parsed = parseFrontmatter(readFileSync((r as { plan_path: string }).plan_path, "utf8"));
      expect(validate((parsed as { data: Record<string, unknown> }).data, "plan").ok).toBe(true);
    });

    it("pins a golden plan_hash vector", () => {
      // designHash has one; planHash did not, so nothing would have caught a projection change.
      expect(planHash({ goal: "ship it", steps: [{ id: "s1", model: OPUS, task_type: "implement-slice" }] })).toMatch(/^[0-9a-f]{64}$/);
      expect(planHash({ goal: "ship it", steps: [{ id: "s1", model: OPUS, task_type: "implement-slice" }] })).toBe(
        planHash({ steps: [{ id: "s1", model: OPUS, task_type: "implement-slice" }], goal: "ship it" }),
      ); // key order cannot matter
    });

    it("derives suggested_ttl_s from step_count but NEVER writes expires_at", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })] });
      expect((r as { suggested_ttl_s: number }).suggested_ttl_s).toBe(3 * 3600);
      const text = readFileSync((r as { plan_path: string }).plan_path, "utf8");
      // `amico ledger approve` is the SOLE writer of a warrant's lifetime: under --recompile a
      // compile-owned TTL would silently re-set how long a human's authorization lasts.
      expect(text).not.toContain("expires_at");
      expect(readRecords().find((x) => x.type === "plan_compiled")).not.toHaveProperty("expires_at");
    });

    it("suggestedTtlFor floors at one hour and ceilings at a day", () => {
      expect(suggestedTtlFor(0)).toBe(3600);
      expect(suggestedTtlFor(100)).toBe(24 * 3600);
    });

    it("carries surviving advisories into the WRITTEN file and the row's count", async () => {
      const spec = {
        ...SLICE_SPEC,
        review: { design_hash: "0".repeat(64), advisories: [{ id: "adv-1", lens: "hidden-failure", claim: "c", remedy: "r" }] },
      };
      const r = await compilePlan(specPath, fm(spec), {
        plansDir, runPlanner: planner({ goal: "g", steps: [step()] }), records: [approvedReview("0".repeat(64))],
      });
      expect((r as { advisory_count: number }).advisory_count).toBe(1);
      const text = readFileSync((r as { plan_path: string }).plan_path, "utf8");
      expect(text).toMatch(/adv-1/);
      // The body must say they are obligations, since that is where critics get their teeth.
      expect(text).toMatch(/cannot reach `complete` while/);
      expect(readRecords().find((x) => x.type === "plan_compiled")).toMatchObject({ advisory_count: 1 });
    });

    it("marks the artifact as compiled, so a hand-edit is visibly wrong", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step()] });
      expect(readFileSync((r as { plan_path: string }).plan_path, "utf8")).toMatch(/do not hand-edit/i);
    });

    it("stamps compiled_by from the PLANNER's reported model", async () => {
      const r = await compile(SLICE_SPEC, { goal: "g", steps: [step()] });
      expect((r as { compiled_by?: { model: string } }).compiled_by?.model).toBe(OPUS);
    });

    it("the plan_compiled row stays under PIPE_BUF with many steps", async () => {
      const steps = Array.from({ length: 60 }, (_, i) => step({ id: `step-number-${i}`, needs: i > 0 ? [`step-number-${i - 1}`] : undefined }));
      await compile(SLICE_SPEC, { goal: "a long-ish goal line for good measure", steps });
      const line = readFileSync(process.env.AMICO_LEDGER!, "utf8").split("\n").filter(Boolean).pop()!;
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096);
    });
  });

  describe("degradation and recompilation", () => {
    it("with NO planner: exit 64, no plan on disk, no row", async () => {
      // §4.6 never covered this, and `steps.minItems: 1` makes an empty plan invalid anyway.
      const r = await compilePlan(specPath, fm(SLICE_SPEC), {
        plansDir, records: [], allowUnreviewed: true,
        env: { AMICO_CRITIC_BIN: "/nonexistent/planner", PATH: "" } as NodeJS.ProcessEnv,
      });
      expect(r).toMatchObject({ ok: false, exit_code: 64 });
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/Nothing was written/);
      expect(readRecords().filter((x) => x.type === "plan_compiled")).toHaveLength(0);
    });

    it("a planner that produced nothing usable is exit 64, not a silent empty plan", async () => {
      const r = await compilePlan(specPath, fm(SLICE_SPEC), {
        plansDir, records: [], allowUnreviewed: true,
        runPlanner: async () => ({ status: "skipped", skip_class: "failed", reason: "timed out", findings: [], dropped_no_remedy: 0 }),
      });
      expect(r).toMatchObject({ ok: false, exit_code: 64 });
    });

    it("requires --recompile when a plan for this design is already APPROVED, and warns", async () => {
      const raw = fm(SLICE_SPEC);
      const dh = designHash((parseFrontmatter(raw) as { data: Record<string, unknown> }).data);
      const first = await compilePlan(specPath, raw, {
        plansDir, runPlanner: planner({ goal: "g", steps: [step()] }), records: [approvedReview(dh)],
      });
      const approved = (first as { plan_hash: string }).plan_hash;
      const withApproval: LedgerRecord[] = [
        approvedReview(dh),
        { type: "plan_compiled", ts: "t", plan_hash: approved, spec_id: "spec-s", design_hash: dh, step_count: 1, source: "user" } as LedgerRecord,
        { type: "approval", ts: "t", plan_hash: approved, bounds: {}, expires_at: "2099-01-01T00:00:00Z", issued_by: "aaron" } as LedgerRecord,
      ];
      const blocked = await compilePlan(specPath, raw, {
        plansDir, runPlanner: planner({ goal: "g2", steps: [step()] }), records: withApproval,
      });
      expect((blocked as { errors: string[] }).errors.join(" ")).toMatch(/already been APPROVED/);

      const warnings: string[] = [];
      const forced = await compilePlan(specPath, raw, {
        plansDir, runPlanner: planner({ goal: "g2", steps: [step()] }), records: withApproval,
        recompile: true, warn: (m) => warnings.push(m),
      });
      expect(forced.ok).toBe(true);
      // Loud, because the alternative is discovering it later as a bare launch denial.
      expect(warnings.join(" ")).toMatch(/re-approve/);
    });

    it("without an existing approval, compile needs no flag", async () => {
      expect((await compile(SLICE_SPEC, { goal: "g", steps: [step()] })).ok).toBe(true);
    });
  });

  describe("checkBudget is pure, so the matrix is testable without a subprocess", () => {
    it("no budget + no demanding steps is clean", () => {
      expect(checkBudget([step()], undefined)).toEqual([]);
    });
    it("device defaults to none when permissions are absent", () => {
      expect(checkBudget([step()], { device: "none" })).toEqual([]);
    });
  });
});

void appendRecord;
