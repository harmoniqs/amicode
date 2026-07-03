import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseScoreMd, loadRepertoire } from "../../src/scores/loader";

const GOOD = `---
type: score
schema_version: 1
id: demo
version: 1
derived_from: null
name: "Demo score"
outcome: "A demo outcome"
audience: [testers]
entitlements: []
stages:
  - id: one
    questions:
      - {id: q1, prompt: "Pick?", choices: [a, b], default: a}
  - id: two
    emits: [system]
---
# Body

The Hamiltonian is $\\hat H/\\hbar = \\omega \\hat a^\\dagger\\hat a$ — preserved verbatim.
`;

describe("parseScoreMd", () => {
  it("splits frontmatter from body, body verbatim", () => {
    const { manifest, body } = parseScoreMd(GOOD, "demo/SCORE.md");
    expect(manifest.id).toBe("demo");
    expect(manifest.stages).toHaveLength(2);
    expect(body).toContain("$\\hat H/\\hbar = \\omega \\hat a^\\dagger\\hat a$");
  });
  it("throws with the source path on missing frontmatter", () => {
    expect(() => parseScoreMd("no frontmatter here", "x/SCORE.md")).toThrow(/x\/SCORE\.md/);
  });
  it("throws with validation errors on an invalid manifest", () => {
    const bad = GOOD.replace("version: 1", "version: 0");
    expect(() => parseScoreMd(bad, "y/SCORE.md")).toThrow(/positive integer/);
  });
});

describe("loadRepertoire", () => {
  it("isolates broken scores — never throws, reports errors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scores-"));
    fs.mkdirSync(path.join(root, "good"));
    fs.writeFileSync(path.join(root, "good", "SCORE.md"), GOOD);
    fs.mkdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(root, "broken", "SCORE.md"), "---\ntype: nonsense\n---\nbody");
    fs.mkdirSync(path.join(root, "memory")); // reserved dir, skipped
    fs.mkdirSync(path.join(root, "empty")); // no SCORE.md, skipped

    const load = loadRepertoire(root);
    expect(load.scores).toHaveLength(1);
    expect(load.scores[0].manifest.id).toBe("demo");
    expect(load.scores[0].dir).toBe(path.join(root, "good"));
    expect(load.errors).toHaveLength(1);
    expect(load.errors[0].path).toContain("broken");
  });
  it("returns empty on a missing root", () => {
    expect(loadRepertoire("/nonexistent/scores")).toEqual({ scores: [], errors: [] });
  });
});
