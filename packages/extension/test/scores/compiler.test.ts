import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileScore, compileChainedScore, spliceIntoAgentsMd } from "../../src/scores/compiler";
import { loadRepertoire } from "../../src/scores/loader";

const SCORES_ROOT = path.resolve(__dirname, "..", "..", "scores");

function score0() {
  const load = loadRepertoire(SCORES_ROOT);
  const s = load.scores.find((x) => x.manifest.id === "pulse-designer");
  if (!s) throw new Error("score #0 missing");
  return s;
}

function overture() {
  const load = loadRepertoire(SCORES_ROOT);
  const s = load.scores.find((x) => x.manifest.id === "overture");
  if (!s) throw new Error("overture missing");
  return s;
}

describe("compileScore (score #0)", () => {
  const md = compileScore(score0());

  it("keeps the heading the agent prompt references", () => {
    expect(md).toContain("## Pulse-designer interview");
  });
  it("emits every stage id in manifest order", () => {
    const ids = ["platform", "model", "mode", "problem", "formulate", "solve", "inspect", "hardware"];
    const idx = ids.map((s) => md.indexOf(`**${s}**`));
    idx.forEach((i, k) => expect(i, `stage ${ids[k]}`).toBeGreaterThan(-1));
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBeGreaterThan(idx[k - 1]);
  });
  it("marks defaults (recommended) and no longer routes choice questions via amicode_ask", () => {
    expect(md).toContain("transmon (recommended)");
    // amicode_ask is deprecated (one ask mechanism: the question card) — the
    // contract must not route choice questions through it anymore.
    expect(md).not.toMatch(/options list go through `amicode_ask`/);
  });
  it("teaches one ask mechanism: every question is a card via the question tool", () => {
    expect(md).toMatch(/every question is a card/i);
  });
  it("instructs free-form questions to use the question tool with the text kind (amicode#245 AC5)", () => {
    expect(md).toContain('kind: "text"');
    // the retired contract phrasing — free-form questions are NEVER plain text
    expect(md).not.toMatch(/free-form questions stay\s+plain text/i);
  });
  it("drops the plain-text permission for free-form answers from the score body (amicode#245 AC5)", () => {
    expect(md).not.toContain("plain text");
  });
  it("keeps the choice-question mandate intact (amicode#245 AC6 regression)", () => {
    expect(md).toContain("MUST call the native `question` tool");
    expect(md).toContain('"(Recommended)"');
  });
  it("substitutes the score-relative template to an absolute path", () => {
    expect(md).toContain(path.join(SCORES_ROOT, "pulse-designer", "templates", "solve.jl"));
  });
  it("carries the prose body verbatim (LaTeX intact)", () => {
    expect(md).toContain("\\hat H/\\hbar");
    expect(md).toContain("Never silently co-optimize");
  });
  it("mentions memory hooks for the [Why?] affordance", () => {
    expect(md).toContain("free-phase-objective-only");
  });
  it("is deterministic", () => {
    expect(compileScore(score0())).toBe(md);
  });
  it("leaves no unknown {{...}} placeholders", () => {
    expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe("compileChainedScore (real overture → pulse-designer)", () => {
  const md = compileChainedScore(overture(), score0());

  it("instructs free-form questions to use the question tool with the text kind (amicode#245 AC5)", () => {
    expect(md).toContain('kind: "text"');
  });
  it("drops the plain-text permission from the overture body (amicode#245 AC5)", () => {
    expect(md).not.toContain("free-form answers can be plain text");
    expect(md).not.toContain("plain text");
  });
  it("keeps the overture's choice questions as option cards, default first (amicode#245 AC6 regression)", () => {
    expect(md).toContain("Perform (automated) experiments and gain scientific insights (recommended)");
    expect(md).toContain("General coding and software development");
  });
});

describe("spliceIntoAgentsMd", () => {
  const agents = fs.readFileSync(path.resolve(__dirname, "..", "..", "AGENTS.md"), "utf8");

  it("replaces the interview section, keeps surrounding sections", () => {
    const out = spliceIntoAgentsMd(agents, "## Onset router\nROUTER", "## Pulse-designer interview\nCOMPILED");
    expect(out).toContain("## Onset router");
    expect(out).toContain("COMPILED");
    expect(out).toContain("## Identity"); // section before, untouched
    expect(out).toContain("## Style & formatting"); // section after splice point, untouched (ADR 0008: run-dir contract moved to solve skill)
    // the hardcoded interview body is gone from the spliced output
    expect(out).not.toContain("Stages, in order:");
    // exactly one interview heading remains
    expect(out.split("## Pulse-designer interview")).toHaveLength(2);
  });
  it("appends when the heading is missing (never loses content)", () => {
    const out = spliceIntoAgentsMd("# Something else\n", "## R", "## C");
    expect(out).toContain("# Something else");
    expect(out).toContain("## C");
  });
});
