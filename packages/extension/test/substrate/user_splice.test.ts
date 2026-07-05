import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAboutUserSection, buildRecentProblemsSection, buildReferenceDemosSection } from "../../src/substrate/user_splice";
import { buildOpencodeConfigContent, prepareOpencodeProject } from "../../src/opencode_config";

describe("buildAboutUserSection (spec §6)", () => {
  it("empty profile → empty string (no section)", () => {
    expect(buildAboutUserSection("")).toBe("");
  });
  it("carries the profile verbatim + the greet/anchor/never-re-ask instruction", () => {
    const s = buildAboutUserSection("# Profile — Aaron\n- Role: CEO\n");
    expect(s).toContain("## About this user");
    expect(s).toContain("Role: CEO");
    expect(s).toMatch(/never re-ask/i);
    expect(s).toMatch(/environment/i); // anchor the hardware stage on the environment card
  });
});

describe("buildRecentProblemsSection (spec §6)", () => {
  it("no lines → empty string", () => {
    expect(buildRecentProblemsSection([])).toBe("");
  });
  it("carries the knowledge lines + warm-start/lesson instruction", () => {
    const s = buildRecentProblemsSection([
      "- [x-gate-transmon](problems/x-gate-transmon.md) — solved 8×, pulse: x-gate-transmon-v1",
    ]);
    expect(s).toContain("## Your recent problems");
    expect(s).toContain("x-gate-transmon-v1");
    expect(s).toMatch(/warm start/i);
    expect(s).toMatch(/lesson/i);
  });
});

describe("vault wiring (grant + splice + return)", () => {
  it("buildOpencodeConfigContent grants <vault>/amicode/** only when a vault dir is passed", () => {
    const withVault = JSON.parse(
      buildOpencodeConfigContent("/a.md", "/t/tmpl.jl", "/runs", undefined, undefined, [], "", "/my/vault"),
    );
    expect(withVault.permission.external_directory["/my/vault/amicode/**"]).toBe("allow");
    const without = JSON.parse(buildOpencodeConfigContent("/a.md", "/t/tmpl.jl", "/runs"));
    const keys = Object.keys(without.permission.external_directory).join("\n");
    expect(keys).not.toContain("amicode/**");
  });
  it("prepareOpencodeProject splices both sections when the vault has profile+knowledge, and returns vaultDir", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    fs.mkdirSync(path.join(vault, "amicode"), { recursive: true });
    fs.writeFileSync(path.join(vault, "amicode", "PROFILE.md"), "# Profile — T\n- Role: tester\n");
    fs.writeFileSync(
      path.join(vault, "amicode", "KNOWLEDGE.md"),
      "- [x-gate](problems/x-gate.md) — solved, pulse: x-gate-v1\n",
    );
    const proj = prepareOpencodeProject({
      agentsSrc: "/nonexistent-agents.md",
      templateSrc: "/tmp/none.jl",
      juliaProject: "/tmp/jp",
      vaultDir: vault,
    });
    expect(proj.vaultDir).toBe(vault);
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## About this user");
    expect(agents).toContain("Role: tester");
    expect(agents).toContain("## Your recent problems");
    expect(agents).toContain("x-gate-v1");
  });
  it("explicit empty vaultDir disables personalization (no spliced sections, no throw)", () => {
    const proj = prepareOpencodeProject({
      agentsSrc: "/nonexistent-agents.md",
      templateSrc: "/tmp/none.jl",
      juliaProject: "/tmp/jp",
      vaultDir: "",
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    // Key on splice-UNIQUE sentinels, not the section headings — the pulse-designer
    // SCORE.md prose legitimately references "## About this user" when instructing
    // the agent to anchor on it. The actual spliced sections carry these lines:
    expect(agents).not.toContain("Greet and recommend with this context");
    expect(agents).not.toContain("Before recommending parameters, check whether");
  });
});

describe("buildReferenceDemosSection (L1 §3)", () => {
  it("empty → ''", () => {
    expect(buildReferenceDemosSection([])).toBe("");
  });
  it("renders demo lines + the precedent/medium-confidence instruction", () => {
    const s = buildReferenceDemosSection(["- [stanford-bosonics-cat](demos/stanford-bosonics-cat.md) — cavity cat, N_fock=20"]);
    expect(s).toContain("## Reference demos");
    expect(s).toContain("N_fock=20");
    expect(s).toMatch(/precedent/i);
    expect(s).toMatch(/medium confidence/i);
  });
});
