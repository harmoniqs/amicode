// The `amico spec` verb (spec-20260728 §3).
// Plan: plan-20260728-104500 Task 11.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specVerb } from "../src/spec_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";

const SLICE = `---
schema_version: "1"
spec_id: spec-slice
task_type: implement-slice
acceptance: ["x == 1"]
---

body
`;
const PROSE = SLICE.replace('["x == 1"]', '["it should be good"]');

describe("amico spec", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-verb-"));
    path = join(dir, "spec.md");
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  const json = (r: { json: unknown }) => r.json as Record<string, unknown>;

  it("exit 0 + approved-mechanical on a clean spec", async () => {
    writeFileSync(path, SLICE);
    const r = await specVerb(["review", path]);
    expect(r.code).toBe(0);
    expect(json(r).review_verdict).toBe("approved-mechanical");
  });

  it("exit 65 + blocking, with the findings INLINE so the refusal is actionable", async () => {
    writeFileSync(path, PROSE);
    const r = await specVerb(["review", path]);
    expect(r.code).toBe(65);
    expect(json(r).review_verdict).toBe("blocking");
    const blocking = json(r).blocking as Array<Record<string, string>>;
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0].remedy).toBeTruthy();
  });

  it("the verdict is in the PAYLOAD too, because the MCP facade discards exit codes", async () => {
    writeFileSync(path, SLICE);
    const r = await specVerb(["review", path]);
    expect(json(r)).toHaveProperty("review_verdict");
    expect(json(r)).toHaveProperty("exit_code", 0);
  });

  it("exit 64 on usage errors: no path, unknown subcommand, bad --critics", async () => {
    expect((await specVerb(["review"])).code).toBe(64);
    expect((await specVerb(["frobnicate"])).code).toBe(64);
    expect((await specVerb([])).code).toBe(64);
    writeFileSync(path, SLICE);
    expect((await specVerb(["review", path, "--critics", "-2"])).code).toBe(64);
    expect((await specVerb(["review", path, "--critics", "many"])).code).toBe(64);
  });

  it("exit 64 when the spec does not exist", async () => {
    expect((await specVerb(["review", join(dir, "nope.md")])).code).toBe(64);
  });

  it("accepts flags before the positional path", async () => {
    writeFileSync(path, SLICE);
    expect((await specVerb(["review", "--offline", path])).code).toBe(0);
  });

  it("does NOT take --spec (that flag belongs to the launch path)", async () => {
    writeFileSync(path, SLICE);
    expect((await specVerb(["review", "--spec", path])).code).toBe(64);
  });

  it("`validate` checks the frontmatter contract alone", async () => {
    writeFileSync(path, SLICE);
    expect((await specVerb(["validate", path])).code).toBe(0);
    writeFileSync(path, SLICE.replace("spec_id: spec-slice\n", ""));
    const r = await specVerb(["validate", path]);
    expect(r.code).toBe(65);
    expect((json(r).errors as string[]).join(" ")).toMatch(/spec_id/);
  });

  it("is registered in SPINE_VERBS with the fields Verb requires", async () => {
    const v = SPINE_VERBS.find((x) => x.name === "spec");
    expect(v).toBeDefined();
    expect(v!.summary).toBeTruthy();
    expect(v!.generalizes).toBeTruthy();
    expect(v!.slice).toBeTruthy();
    expect(v!.stub).toBeUndefined(); // real body, not a seam
  });
});
