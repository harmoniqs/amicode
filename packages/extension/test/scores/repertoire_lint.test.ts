import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadRepertoire } from "../../src/scores/loader";
import { lintRepertoire } from "../../src/scores/lint";

const EXT_ROOT = path.resolve(__dirname, "..", "..");
const REAL_SCORES = path.join(EXT_ROOT, "scores");

function mkScore(
  root: string,
  id: string,
  opts: { template?: string; hooks?: string[]; derived?: string; ents?: string[] } = {},
) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const q = opts.hooks
    ? `\n    questions:\n      - {id: q1, prompt: "P?", memory_hooks: [${opts.hooks.join(", ")}]}`
    : "";
  const tpl = opts.template ? `\n    template: ${opts.template}` : "";
  fs.writeFileSync(
    path.join(dir, "SCORE.md"),
    `---
type: score
schema_version: 1
id: ${id}
version: 1
derived_from: ${opts.derived ?? "null"}
name: "S ${id}"
outcome: "O"
audience: [t]
entitlements: [${(opts.ents ?? []).join(", ")}]
stages:
  - id: one${q}${tpl}
---
body`,
  );
  return dir;
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return root;
}

describe("lintRepertoire", () => {
  it("flags an unresolvable template path", () => {
    const root = tmpRoot();
    mkScore(root, "a", { template: "templates/missing.jl" });
    const errs = lintRepertoire(loadRepertoire(root), path.join(root, "memory"), []);
    expect(errs.join()).toMatch(/template.*missing\.jl/i);
  });
  it("flags an unresolvable memory hook", () => {
    const root = tmpRoot();
    mkScore(root, "a", { hooks: ["no-such-hook"] });
    const errs = lintRepertoire(loadRepertoire(root), path.join(root, "memory"), []);
    expect(errs.join()).toMatch(/memory hook.*no-such-hook/i);
  });
  it("accepts a resolvable memory hook", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "memory", "real-hook.md"), "fact");
    mkScore(root, "a", { hooks: ["real-hook"] });
    expect(lintRepertoire(loadRepertoire(root), path.join(root, "memory"), [])).toEqual([]);
  });
  it("flags derived_from pointing at an unknown score id", () => {
    const root = tmpRoot();
    mkScore(root, "a", { derived: "ghost" });
    const errs = lintRepertoire(loadRepertoire(root), path.join(root, "memory"), []);
    expect(errs.join()).toMatch(/derived_from.*ghost/i);
  });
  it("accepts derived_from pointing at a sibling score", () => {
    const root = tmpRoot();
    mkScore(root, "base");
    mkScore(root, "fork", { derived: "base" });
    expect(lintRepertoire(loadRepertoire(root), path.join(root, "memory"), [])).toEqual([]);
  });
  it("flags an unregistered entitlement id", () => {
    const root = tmpRoot();
    mkScore(root, "a", { ents: ["typo-hackathon"] });
    const errs = lintRepertoire(loadRepertoire(root), path.join(root, "memory"), ["pasqal-hackathon-2026"]);
    expect(errs.join()).toMatch(/entitlement.*typo-hackathon/i);
  });
  it("carries loader errors as lint failures", () => {
    const root = tmpRoot();
    const dir = path.join(root, "broken");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "SCORE.md"), "---\ntype: junk\n---\n");
    const errs = lintRepertoire(loadRepertoire(root), path.join(root, "memory"), []);
    expect(errs.join()).toMatch(/broken/);
  });

  it("the REAL shipped repertoire lints clean", () => {
    const registry = parseToml(fs.readFileSync(path.join(REAL_SCORES, "entitlements.toml"), "utf8")) as {
      known: string[];
    };
    const load = loadRepertoire(REAL_SCORES);
    expect(lintRepertoire(load, path.join(REAL_SCORES, "memory"), registry.known)).toEqual([]);
  });
});
