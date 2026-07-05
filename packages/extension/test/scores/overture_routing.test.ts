import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareOpencodeProject } from "../../src/opencode_config";
import { compileChainedScore, chainManifest } from "../../src/scores/compiler";
import type { Score } from "../../src/scores/loader";

const EXT = path.resolve(__dirname, "..", "..");
const REAL_SCORES = path.join(EXT, "scores");

function mkVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
}
function withProfile(vault: string): string {
  fs.mkdirSync(path.join(vault, "amicode"), { recursive: true });
  fs.writeFileSync(path.join(vault, "amicode", "PROFILE.md"), "# Profile — A\n- Role: CEO\n");
  return vault;
}
function prep(vaultDir: string, opsDir: string) {
  const prev = process.env.AMICODE_OPS_DIR;
  process.env.AMICODE_OPS_DIR = opsDir;
  try {
    return prepareOpencodeProject({
      agentsSrc: path.join(EXT, "AGENTS.md"),
      templateSrc: path.join(EXT, "templates", "solve_template.jl"),
      juliaProject: "/tmp/jp",
      scoresRoot: REAL_SCORES,
      vaultDir,
    });
  } finally {
    if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = prev;
  }
}

describe("overture routing predicate (spec §3)", () => {
  it("no PROFILE.md + no marker → chained overture→pulse-designer session", () => {
    const proj = prep(mkVault(), fs.mkdtempSync(path.join(os.tmpdir(), "ops-")));
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("overture");
    expect(agents).toContain("After onboarding — continue into pulse design");
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("overture");
    // chained manifest carries BOTH stage sets → the guard sees the whole flow
    const ids = manifest.manifest.stages.map((s: { id: string }) => s.id);
    expect(ids).toContain("identity"); // overture
    expect(ids).toContain("solve"); // pulse-designer
  });
  it("non-empty PROFILE.md → pulse-designer only (no overture)", () => {
    const proj = prep(withProfile(mkVault()), fs.mkdtempSync(path.join(os.tmpdir(), "ops-")));
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("pulse-designer");
  });
  it("completion marker (no PROFILE yet — the ~2-min window) → pulse-designer, not overture", () => {
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"));
    fs.mkdirSync(path.join(ops, "onboarding"), { recursive: true });
    fs.writeFileSync(
      path.join(ops, "onboarding", "events.jsonl"),
      JSON.stringify({ entity: "onboarding_completed" }) + "\n",
    );
    const proj = prep(mkVault(), ops);
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("pulse-designer");
  });
  it("no vault (personalization off) → pulse-designer, never overture", () => {
    const proj = prep("", fs.mkdtempSync(path.join(os.tmpdir(), "ops-")));
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("pulse-designer");
  });
});

describe("compileChainedScore / chainManifest (unit)", () => {
  const head: Score = {
    manifest: { type: "score", schema_version: 1, id: "overture", version: 1, derived_from: null, name: "O", outcome: "", audience: [], stages: [{ id: "identity" }, { id: "handoff" }] } as never,
    body: "OVERTURE BODY",
    dir: "/scores/overture",
  };
  const tail: Score = {
    manifest: { type: "score", schema_version: 1, id: "pulse-designer", version: 3, derived_from: null, name: "P", outcome: "", audience: [], stages: [{ id: "platform" }, { id: "solve", template: "templates/solve.jl" }] } as never,
    body: "PULSE BODY",
    dir: "/scores/pulse-designer",
  };
  it("numbers stages continuously and resolves tail templates against the tail dir", () => {
    const out = compileChainedScore(head, tail);
    expect(out).toMatch(/1\. \*\*identity\*\*/);
    expect(out).toMatch(/2\. \*\*handoff\*\*/);
    expect(out).toMatch(/3\. \*\*platform\*\*/);
    expect(out).toMatch(/4\. \*\*solve\*\*/);
    expect(out).toContain("/scores/pulse-designer/templates/solve.jl"); // tail dir, not head dir
    expect(out).toContain("OVERTURE BODY");
    expect(out).toContain("PULSE BODY");
  });
  it("chainManifest = head identity + concatenated stages", () => {
    const m = chainManifest(head, tail);
    expect(m.id).toBe("overture");
    expect(m.stages.map((s) => s.id)).toEqual(["identity", "handoff", "platform", "solve"]);
  });
});
