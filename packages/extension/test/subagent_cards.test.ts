// subagent_cards.test.ts — #2093: the dedicated critic subagent card and the
// receipt return contract every subagent card states.
//
// The 14-day audit (2026-11-02) found critics running as the built-in
// general/analyzer/explore agents and subagent results averaging 8.4k chars,
// re-read on every later director step. Two floors follow:
//
//   - CRITIC — a shipped, read-only, one-lens card whose blocking findings
//     must quote the contradicted text and whose verdict vocabulary is
//     approved|changes|blocked. No model id (machine-local config pins
//     models per role).
//   - RECEIPT — every subagent card carries the SAME "Return contract
//     (receipt)" section, byte-identical: the full work product goes to a
//     file, the final message is a bounded receipt.
//
// Plus the deploy surface: the operator's deploy-agents.mjs list covers
// every shipped card, so a new card never silently misses a deploy.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listSubagentRoles } from "../opencode-plugin/model_routing";

const AGENTS_DIR = join(__dirname, "..", "agents");
const DEPLOY_SCRIPT = join(__dirname, "..", "..", "..", "scripts", "deploy-agents.mjs");
const SUBAGENTS = ["analyzer", "critic", "experimenter", "hypothesizer", "implementer", "librarian"];
const RECEIPT_HEADING = "## Return contract (receipt)";

const card = (role: string) => readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");
const frontmatter = (text: string) => {
  expect(text.startsWith("---\n")).toBe(true);
  return text.slice(4, text.indexOf("\n---\n", 4));
};
/** The section from its heading to the next `## ` heading (or EOF). */
const section = (text: string, heading: string) => {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next === -1 ? text.length : next + 1).trimEnd();
};

describe("the critic card (#2093)", () => {
  const text = card("critic");
  const fm = frontmatter(text);

  it("is a read-only subagent: temperature 0.1, a ~40 step cap, edit and bash denied", () => {
    expect(fm).toMatch(/^mode:\s*subagent$/m);
    expect(fm).toMatch(/^temperature:\s*0\.1$/m);
    const steps = Number(/^steps:\s*(\d+)$/m.exec(fm)?.[1]);
    expect(steps).toBeGreaterThanOrEqual(30);
    expect(steps).toBeLessThanOrEqual(50);
    expect(fm).toMatch(/^permission:\n\s+edit:\s*deny\n\s+bash:\s*deny$/m);
  });

  it("carries no model id and no overlay dispatch target", () => {
    expect(fm).not.toMatch(/^model:/m);
    expect(fm).not.toMatch(/^dispatch:/m);
  });

  it("states the critic's rules: one lens, quoted blocking findings, the verdict vocabulary, no rewrite, no self-grading", () => {
    expect(text).toMatch(/one\s+lens\s+per\s+cast/i);
    expect(text).toMatch(/brief\s+file/i);
    expect(text).toMatch(/blocking\s+only\s+when\s+it\s+quotes\s+the\s+contradicted\s+text/i);
    expect(text).toContain("approved|changes|blocked");
    expect(text).toMatch(/YAML/);
    expect(text).toMatch(/never\s+rewrite\s+the\s+spec/i);
    expect(text).toMatch(/never\s+grade\s+your\s+own\s+prior\s+round/i);
  });

  it("names a model CLASS for routing, never a concrete model", () => {
    expect(text).toMatch(/^Model routing, suggested: (workhorse|strongest-reasoner|fast-cheap)/m);
    expect(text).not.toMatch(/\b(claude|gpt|gemini|opus|sonnet)[-\w.]*\d/i);
  });
});

describe("the receipt return contract (#2093)", () => {
  it("the subagent card set is exactly the six roles", () => {
    expect(listSubagentRoles(AGENTS_DIR).sort()).toEqual(SUBAGENTS);
  });

  it("every subagent card states the receipt contract, byte-identical across cards", () => {
    const sections = SUBAGENTS.map((role) => section(card(role), RECEIPT_HEADING));
    for (const [i, role] of SUBAGENTS.entries()) {
      expect(sections[i], `${role} carries "${RECEIPT_HEADING}"`).not.toBe("");
    }
    for (const [i, role] of SUBAGENTS.entries()) {
      expect(sections[i], `${role}'s receipt section matches analyzer's`).toBe(sections[0]);
    }
  });

  it("the contract names the file hand-off, the ~1,500-token bound, and the receipt's fields", () => {
    const s = section(card("analyzer"), RECEIPT_HEADING);
    expect(s).toMatch(/file/i);
    expect(s).toMatch(/caller\s+names/i);
    expect(s).toMatch(/scratch\s+path/i);
    const flat = s.replace(/\s+/g, " ").toLowerCase();
    expect(flat).toContain("1,500 tokens");
    for (const field of ["verdict", "key numbers", "artifact paths", "open items"]) {
      expect(flat).toContain(field);
    }
  });

  it("the implementer keeps its structured result as its receipt", () => {
    const text = card("implementer");
    expect(text).toMatch(/commit_shas/);
    expect(text).toMatch(/structured (yaml|result)[^.]*IS (its|your) receipt/i);
  });
});

describe("the deploy surface covers every shipped card", () => {
  it("scripts/deploy-agents.mjs lists every card in packages/extension/agents", () => {
    const script = readFileSync(DEPLOY_SCRIPT, "utf8");
    const list = /const CARDS = \[([\s\S]*?)\];/.exec(script)?.[1] ?? "";
    const listed = [...list.matchAll(/"([^"]+\.md)"/g)].map((m) => m[1]).sort();
    const shipped = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
    expect(listed).toEqual(shipped);
  });
});
