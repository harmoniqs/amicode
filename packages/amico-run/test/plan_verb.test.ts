// The `amico plan` verb (spec-20260728 §4).
// Plan: plan-20260728-160000 Task 5.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { designHash } from "@amicode/schema";
import { readRecords, type LedgerRecord } from "../src/ledger.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { planVerb } from "../src/plan_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { listMcpTools } from "../src/mcp_serve.js";
import type { AgentOutcome } from "../src/agent_spawn.js";

const OPUS = "anthropic/claude-opus-5";
const SPEC = {
  schema_version: "1", spec_id: "spec-s", task_type: "implement-slice", acceptance: ["x == 1"],
};
const fm = (o: Record<string, unknown>) =>
  "---\n" + Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n---\n\nbody\n";

const planner = (payload: Record<string, unknown>) => async (): Promise<AgentOutcome> => ({
  status: "ran", model: OPUS, variant: "high", findings: [], dropped_no_remedy: 0, payload,
});
const STEPS = [{ id: "s1", model: OPUS, task_type: "implement-slice", gates: ["re-rollout"] }];

const approvedReview = (design_hash: string): LedgerRecord =>
  ({
    type: "spec_review", ts: "2026-07-28T10:00:00Z", spec_id: "spec-s", design_hash, rounds: 1,
    review_verdict: "approved", lens_registry_version: "1", lens_status: [],
    critics: [{ model: OPUS, variant: "high" }], findings_count: 0, blocking_count: 0, source: "user",
  }) as LedgerRecord;

describe("amico plan", () => {
  let dir: string;
  let plansDir: string;
  let specPath: string;
  let records: LedgerRecord[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-verb-"));
    plansDir = join(dir, "plans");
    mkdirSync(plansDir);
    specPath = join(dir, "spec.md");
    writeFileSync(specPath, fm(SPEC));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
    const parsed = parseFrontmatter(fm(SPEC));
    records = [approvedReview(designHash((parsed as { data: Record<string, unknown> }).data))];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  const json = (r: { json: unknown }) => r.json as Record<string, unknown>;
  const ctx = () => ({ plansDir, records, runPlanner: planner({ goal: "ship it", steps: STEPS }) });

  describe("usage discipline, mirroring spec_verb", () => {
    it("compile takes a POSITIONAL spec path", async () => {
      const r = await planVerb(["compile", specPath], ctx());
      expect(r.code).toBe(0);
      expect(json(r).plan_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("REJECTS unknown flags rather than ignoring them", async () => {
      // Silently accepting --spec would "work" and teach the caller a flag that belongs to the
      // launch path, which is worse than refusing it.
      expect((await planVerb(["compile", "--spec", specPath], ctx())).code).toBe(64);
      expect((await planVerb(["compile", specPath, "--forcefully"], ctx())).code).toBe(64);
    });

    it("registers --recompile and --allow-unreviewed", async () => {
      expect((await planVerb(["compile", specPath, "--allow-unreviewed"], ctx())).code).toBe(0);
    });

    it("exit 64 on a missing spec, an unknown subcommand, and no args", async () => {
      expect((await planVerb(["compile", join(dir, "nope.md")], ctx())).code).toBe(64);
      expect((await planVerb(["frobnicate"], ctx())).code).toBe(64);
      expect((await planVerb([], ctx())).code).toBe(64);
      expect((await planVerb(["compile"], ctx())).code).toBe(64);
    });

    it("the outcome rides the PAYLOAD as well as the exit code", async () => {
      // The MCP facade returns result.json and discards VerbResult.code.
      const r = await planVerb(["compile", specPath], ctx());
      expect(json(r)).toHaveProperty("ok", true);
      expect(json(r)).toHaveProperty("plan_path");
      const bad = await planVerb(["compile", specPath], { ...ctx(), records: [] });
      expect(json(bad)).toHaveProperty("exit_code", 65);
      expect(json(bad).errors).toBeInstanceOf(Array);
    });

    it("compile DISCLOSES the bounds it could not check", async () => {
      expect(json(await planVerb(["compile", specPath], ctx())).unchecked).toEqual(["max_size_class", "tier"]);
    });

    it("compile points at the next step, since a plan alone authorises nothing", async () => {
      expect(String(json(await planVerb(["compile", specPath], ctx())).next)).toMatch(/amico ledger approve --plan/);
    });
  });

  describe("status", () => {
    const compiled = async () => {
      const r = await planVerb(["compile", specPath], ctx());
      return String(json(r).plan_hash);
    };

    it("reports the derived step states and the plan state", async () => {
      const hash = await compiled();
      const r = await planVerb(["status", hash], { plansDir, records: readRecords() });
      expect(r.code).toBe(0);
      expect(json(r).plan_state).toBe("active");
      // Honest: nothing emits step verdicts until the harness walk lands (G-1b).
      expect((json(r).steps as Array<{ state: string }>).map((s) => s.state)).toEqual(["pending"]);
    });

    it("defaults to the most recently compiled plan", async () => {
      const hash = await compiled();
      expect(json(await planVerb(["status"], { plansDir, records: readRecords() })).plan_hash).toBe(hash);
    });

    it("an unknown plan_hash is a CLEAN empty answer, not a crash", async () => {
      const r = await planVerb(["status", "f".repeat(64)], { plansDir, records: [] });
      expect(r.code).toBe(0);
      expect(json(r).note).toMatch(/no plan with hash/);
    });

    it("says so when the ledger knows a plan but its note is missing", async () => {
      const hash = await compiled();
      rmSync(join(plansDir), { recursive: true, force: true });
      mkdirSync(plansDir);
      const r = await planVerb(["status", hash], { plansDir, records: readRecords() });
      expect(json(r).known_to_ledger).toBe(true);
      expect(String(json(r).note)).toMatch(/its note was not found/);
    });

    it("with no plan compiled at all it reports that, at exit 0", async () => {
      const r = await planVerb(["status"], { plansDir, records: [] });
      expect(r.code).toBe(0);
      expect(json(r).note).toMatch(/no plan has been compiled yet/);
    });

    it("renders remaining warrant time from the APPROVAL, not from suggested_ttl_s", async () => {
      // The fixture makes them DISAGREE on purpose: an implementation reading
      // plan_compiled.suggested_ttl_s — which §4.6 forbids as a lifetime source — would report
      // 7200s here instead of 1800s and still look plausible.
      const hash = await compiled();
      const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
      const rows: LedgerRecord[] = [
        ...readRecords(),
        { type: "approval", ts: "t", plan_hash: hash, bounds: {}, expires_at: "2026-07-28T12:30:00.000Z", issued_by: "aaron" } as LedgerRecord,
      ];
      const w = json(await planVerb(["status", hash], { plansDir, records: rows, nowMs: () => nowMs })).warrant as {
        remaining_s: number; expired: boolean; issued_by: string;
      };
      expect(w.remaining_s).toBe(1800);
      expect(w.expired).toBe(false);
      expect(w.issued_by).toBe("aaron");
    });

    it("an UNPARSEABLE expiry reads as already expired (fail closed)", async () => {
      const hash = await compiled();
      const rows: LedgerRecord[] = [
        ...readRecords(),
        { type: "approval", ts: "t", plan_hash: hash, bounds: {}, expires_at: "whenever", issued_by: "aaron" } as LedgerRecord,
      ];
      const w = json(await planVerb(["status", hash], { plansDir, records: rows })).warrant as { expired: boolean; remaining_s: number };
      expect(w).toMatchObject({ expired: true, remaining_s: 0 });
    });

    it("surfaces that a plan was compiled from an unreviewed spec", async () => {
      await planVerb(["compile", specPath, "--allow-unreviewed"], { ...ctx(), records: [] });
      const rows = readRecords();
      const hash = String((rows.find((r) => r.type === "plan_compiled") as { plan_hash: string }).plan_hash);
      expect(json(await planVerb(["status", hash], { plansDir, records: rows })).not_adversarially_reviewed).toBe(true);
    });
  });

  describe("advisory", () => {
    const withAdvisory = async () => {
      const spec = { ...SPEC, review: { design_hash: "0".repeat(64), advisories: [{ id: "adv-1", lens: "hidden-failure", claim: "c", remedy: "r" }] } };
      writeFileSync(specPath, fm(spec));
      const r = await planVerb(["compile", specPath], {
        plansDir, records: [approvedReview("0".repeat(64))], runPlanner: planner({ goal: "g", steps: STEPS }),
      });
      return String(json(r).plan_hash);
    };

    it("REQUIRES --reason when --state waived", async () => {
      // Surfaced as a usage error rather than an append failure: the schema's if/then would
      // reject the row, but only after the user believed they had waived something.
      const hash = await withAdvisory();
      const bad = await planVerb(["advisory", "adv-1", "--state", "waived", "--plan", hash], { plansDir, records: readRecords() });
      expect(bad.code).toBe(64);
      expect(String(json(bad).error)).toMatch(/--reason is required/);
      const ok = await planVerb(["advisory", "adv-1", "--state", "waived", "--reason", "out of scope", "--plan", hash], {
        plansDir, records: readRecords(),
      });
      expect(ok.code).toBe(0);
    });

    it("rejects a state outside {fixed, waived, obsolete}", async () => {
      const hash = await withAdvisory();
      const r = await planVerb(["advisory", "adv-1", "--state", "done", "--plan", hash], { plansDir, records: readRecords() });
      expect(r.code).toBe(64);
      expect(String(json(r).error)).toMatch(/must be one of/);
    });

    it("rejects a reason over the schema's 200-char cap BEFORE appending", async () => {
      const hash = await withAdvisory();
      const r = await planVerb(
        ["advisory", "adv-1", "--state", "waived", "--reason", "x".repeat(201), "--plan", hash],
        { plansDir, records: readRecords() },
      );
      expect(r.code).toBe(64);
      expect(readRecords().filter((x) => x.type === "todo")).toHaveLength(0);
    });

    it("rejects an id the plan never DECLARED — the completion denominator is not user-supplied", async () => {
      const hash = await withAdvisory();
      const r = await planVerb(["advisory", "invented", "--state", "fixed", "--plan", hash], { plansDir, records: readRecords() });
      expect(r.code).toBe(64);
      expect(String(json(r).error)).toMatch(/is not declared by plan/);
    });

    it("closing the advisory moves the plan toward complete", async () => {
      const hash = await withAdvisory();
      await planVerb(["advisory", "adv-1", "--state", "fixed", "--plan", hash], { plansDir, records: readRecords() });
      const view = json(await planVerb(["status", hash], { plansDir, records: readRecords() }));
      expect(view.open_advisories).toBe(0);
      expect((view.advisories as Array<{ state: string }>)[0].state).toBe("fixed");
    });

    it("requires an id", async () => {
      expect((await planVerb(["advisory", "--state", "fixed"], { plansDir, records: [] })).code).toBe(64);
    });

    it("requires --state", async () => {
      const hash = await withAdvisory();
      expect((await planVerb(["advisory", "adv-1", "--plan", hash], { plansDir, records: readRecords() })).code).toBe(64);
    });
  });

  // Rev 1 asserted the NAME `plan todo` was absent, which any unknown-subcommand-64 convention
  // satisfies while `plan step --pass` would still exist. The property is what matters: NO
  // subcommand may write step state.
  describe("there is NO write path for step state", () => {
    it("no subcommand appends a verdict or dispatch row", async () => {
      const before = readRecords().length;
      for (const sub of ["todo", "step", "pass", "complete", "advance", "verdict", "dispatch"]) {
        await planVerb([sub, "s1", "--state", "fixed"], { plansDir, records: [] });
      }
      const after = readRecords();
      expect(after.length).toBe(before);
      expect(after.filter((r) => r.type === "verdict" || r.type === "dispatch")).toHaveLength(0);
    });

    it("the usage text says why, so a caller does not go looking for the flag", async () => {
      expect(String(json(await planVerb([], {})).usage)).toMatch(/DERIVED from gate verdicts/);
    });
  });

  describe("registration", () => {
    it("is in SPINE_VERBS with the fields Verb requires", () => {
      const v = SPINE_VERBS.find((x) => x.name === "plan");
      expect(v).toBeDefined();
      expect(v!.summary).toBeTruthy();
      expect(v!.generalizes).toBeTruthy();
      expect(v!.slice).toBeTruthy();
      expect(v!.stub).toBeUndefined();
    });

    it("appears in the MCP tool list (advisory A-4: registering publishes it)", () => {
      expect(listMcpTools().map((t) => t.name)).toContain("amico_plan");
    });
  });

  describe("the compiled plan is readable by a human, not just by the tool", () => {
    it("names the steps and warns against hand-editing", async () => {
      const r = await planVerb(["compile", specPath], ctx());
      const text = readFileSync(String(json(r).plan_path), "utf8");
      expect(text).toMatch(/# ship it/);
      expect(text).toMatch(/\*\*s1\*\*/);
      expect(text).toMatch(/do not hand-edit/i);
    });
  });
});
