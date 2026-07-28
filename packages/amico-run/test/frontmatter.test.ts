// YAML frontmatter reader for the Spec artifact.
//
// amico-validate cannot serve this: it takes --schema (not --kind), TOML-parses anything
// whose extension is not .json, and returns 64 for BOTH usage error and invalid document
// — which would leave `ran` vs `unverified` undecidable for the schema lens. So the verb
// extracts frontmatter itself and validates in-process.
//
// Returns a RESULT, never throws: a malformed spec must be a blocking FINDING (exit 65),
// not a config error (exit 64).
//
// Plan: plan-20260728-104500 Task 7.
import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("extracts the YAML block and ignores the body", () => {
    const r = parseFrontmatter("---\ntask_type: plan\nacceptance: [a >= 1]\n---\n\n# Body\nprose\n");
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.task_type).toBe("plan");
    expect(r.ok && r.data.acceptance).toEqual(["a >= 1"]);
  });

  it("fails with an actionable message when there is no frontmatter", () => {
    const r = parseFrontmatter("# Just a heading\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/frontmatter/i);
  });

  it("fails on malformed YAML rather than throwing", () => {
    const r = parseFrontmatter("---\na: [unclosed\n---\n");
    expect(r.ok).toBe(false);
  });

  it("fails when the block is not a mapping", () => {
    expect(parseFrontmatter("---\n- just\n- a list\n---\n").ok).toBe(false);
  });

  it("tolerates CRLF", () => {
    const r = parseFrontmatter("---\r\ntask_type: plan\r\n---\r\nbody\r\n");
    expect(r.ok && r.data.task_type).toBe("plan");
  });

  it("requires the opening fence on the FIRST line — a --- later in the body is not frontmatter", () => {
    expect(parseFrontmatter("intro\n---\ntask_type: plan\n---\n").ok).toBe(false);
  });

  it("handles the nested structures the spec schema uses (budget, baseline)", () => {
    const r = parseFrontmatter(
      "---\nbudget:\n  max_solves: 8\n  tier: free\nbaseline:\n  value: 0.968\n  source: published\n---\n",
    );
    expect(r.ok && r.data.budget).toEqual({ max_solves: 8, tier: "free" });
    expect(r.ok && r.data.baseline).toEqual({ value: 0.968, source: "published" });
  });

  it("an empty frontmatter block is a mapping-shaped failure, not a crash", () => {
    expect(parseFrontmatter("---\n---\nbody").ok).toBe(false);
  });

  it("keeps a body-level `---` out of the frontmatter", () => {
    const r = parseFrontmatter("---\ntask_type: plan\n---\nbody\n---\nmore: notparsed\n");
    expect(r.ok && Object.keys(r.data)).toEqual(["task_type"]);
  });
});
