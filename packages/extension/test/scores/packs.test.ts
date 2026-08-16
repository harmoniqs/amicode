import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPacks } from "../../src/scores/packs";

// A minimal but complete pack fixture — mirrors the shape the real
// quantum-control pack will carry (WS1, #369).
const SCORE_MD = `---
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
---

# Body

Verbatim $\\hat H$ body.
`;

const PACK_TOML = `
schema_version = "1"
id = "fixture-pack"
name = "Fixture Pack"
version = 1
scores = ["scores/demo"]
catalog_schema = "catalog-entry"

[onboarding]
primary = "demo"

[[skills]]
path = "skills/demo"
tier = "open"

[corrector]
name = "fixture gate"
paths = ["gates/verify.sh"]
integrity = "gates/integrity.toml"
tier = "open"
`;

/** Build a pack fixture on disk and return its root (the packs dir). */
function fixturePack(root: string, id: string, scoreId = "demo") {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, "scores", scoreId), { recursive: true });
  fs.mkdirSync(path.join(dir, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "gates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scores", scoreId, "SCORE.md"), SCORE_MD.replace(/id: demo/, `id: ${scoreId}`));
  fs.writeFileSync(
    path.join(dir, "PACK.toml"),
    PACK_TOML.replace(/id = "fixture-pack"/, `id = "${id}"`).replace(/scores = \[.*\]/, `scores = ["scores/${scoreId}"]`),
  );
  fs.writeFileSync(path.join(dir, "gates", "verify.sh"), "#!/bin/sh\nexit 0\n");
  // coverage keys match corrector.paths strings EXACTLY (relative to pack dir)
  writeIntegrity(dir, { "gates/verify.sh": sha256(path.join(dir, "gates", "verify.sh")) });
  return dir;
}

import { createHash } from "node:crypto";
const sha256 = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Write a corrector integrity manifest (path → sha256, relative to pack dir). */
function writeIntegrity(packDir: string, files: Record<string, string>) {
  const lines = ["[files]"];
  for (const [k, v] of Object.entries(files)) lines.push(`"${k}" = "${v}"`);
  fs.writeFileSync(path.join(packDir, "gates", "integrity.toml"), lines.join("\n") + "\n");
}

describe("loadPacks", () => {
  it("loads a pack by manifest alone — scores parsed through the existing score machinery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    fixturePack(root, "fixture-pack");

    const load = loadPacks([root]);
    expect(load.errors).toEqual([]);
    expect(load.packs).toHaveLength(1);
    const p = load.packs[0];
    expect(p.manifest.id).toBe("fixture-pack");
    expect(p.dir).toBe(path.join(root, "fixture-pack"));
    // the score is a FIELD of the pack: loaded identically to the repertoire loader
    expect(p.scores).toHaveLength(1);
    expect(p.scores[0].manifest.id).toBe("demo");
    expect(p.scores[0].dir).toBe(path.join(root, "fixture-pack", "scores", "demo"));
    expect(p.scores[0].body).toContain("Verbatim");
  });

  it("a second pack registers by manifest alone — no loader code change (AC3)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    fixturePack(root, "quantum-control");
    fixturePack(root, "qec", "hunt");

    const load = loadPacks([root]);
    expect(load.errors).toEqual([]);
    expect(load.packs.map((p) => p.manifest.id).sort()).toEqual(["qec", "quantum-control"]);
    // each pack's scores resolve against ITS OWN dir
    const qec = load.packs.find((p) => p.manifest.id === "qec")!;
    expect(qec.scores[0].dir).toBe(path.join(root, "qec", "scores", "hunt"));
  });

  it("isolates a broken pack — reported, never thrown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    fixturePack(root, "good-pack");
    const bad = path.join(root, "bad-pack");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "PACK.toml"), 'schema_version = "1"\nid = "bad"\n'); // missing required keys

    const load = loadPacks([root]);
    expect(load.packs.map((p) => p.manifest.id)).toEqual(["good-pack"]);
    expect(load.errors).toHaveLength(1);
    expect(load.errors[0].path).toContain("bad-pack");
    expect(load.errors[0].errors.join()).toContain("invalid pack manifest");
  });

  it("isolates a pack whose score dir is missing — the pack is broken whole", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    const dir = path.join(root, "no-scores");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "PACK.toml"),
      PACK_TOML.replace(/id = "fixture-pack"/, 'id = "no-scores"').replace(/scores = \[.*\]/, 'scores = ["scores/ghost"]'),
    );

    const load = loadPacks([root]);
    expect(load.packs).toHaveLength(0);
    expect(load.errors[0].path).toContain("no-scores");
  });

  it("scans roots in precedence order — an earlier root shadows on id collision", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "packs-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "packs-b-"));
    const a = fixturePack(first, "same-id");
    const b = fixturePack(second, "same-id");
    // make the bodies distinguishable
    fs.writeFileSync(path.join(b, "scores", "demo", "SCORE.md"), SCORE_MD.replace("Verbatim", "Shadowed"));

    const load = loadPacks([first, second]);
    expect(load.packs).toHaveLength(1);
    expect(load.packs[0].dir).toBe(a);
    expect(load.packs[0].scores[0].body).toContain("Verbatim");
  });

  it("skips dirs without a manifest, and missing roots entirely", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    fs.mkdirSync(path.join(root, "not-a-pack"), { recursive: true });
    expect(loadPacks([root, "/nonexistent/packs"]).packs).toEqual([]);
    expect(loadPacks([root, "/nonexistent/packs"]).errors).toEqual([]);
  });
});

describe("corrector integrity (load-time property, #369)", () => {
  it("a corrector path whose sha256 mismatches the integrity manifest breaks the pack", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    const dir = fixturePack(root, "tampered");
    writeIntegrity(dir, { "../gates/verify.sh": "0".repeat(64) }); // wrong hash

    const load = loadPacks([root]);
    expect(load.packs).toHaveLength(0);
    expect(load.errors[0].path).toContain("tampered");
    expect(load.errors[0].errors.join()).toMatch(/sha256|integrity/i);
  });

  it("a corrector path with NO integrity coverage breaks the pack", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    const dir = fixturePack(root, "uncovered");
    writeIntegrity(dir, {}); // manifest exists but covers nothing

    const load = loadPacks([root]);
    expect(load.packs).toHaveLength(0);
    expect(load.errors[0].errors.join()).toMatch(/not covered|integrity/i);
  });

  it("a missing integrity manifest file breaks the pack", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    const dir = fixturePack(root, "no-integrity");
    fs.rmSync(path.join(dir, "gates", "integrity.toml"));

    const load = loadPacks([root]);
    expect(load.packs).toHaveLength(0);
  });

  it("a corrector path inside an agent-editable tree is rejected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-"));
    fixturePack(root, "self-hosted");
    const agentTree = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    // re-point the corrector into the agent tree
    const dir = path.join(root, "self-hosted");
    fs.mkdirSync(agentTree, { recursive: true });
    fs.copyFileSync(path.join(dir, "gates", "verify.sh"), path.join(agentTree, "verify.sh"));
    const manifest = fs.readFileSync(path.join(dir, "PACK.toml"), "utf8")
      .replace('paths = ["gates/verify.sh"]', `paths = ["${path.join(agentTree, "verify.sh")}"]`);
    fs.writeFileSync(path.join(dir, "PACK.toml"), manifest);
    writeIntegrity(dir, { [path.join(agentTree, "verify.sh")]: sha256(path.join(agentTree, "verify.sh")) });

    const load = loadPacks([root], { agentTrees: [agentTree] });
    expect(load.packs).toHaveLength(0);
    expect(load.errors[0].errors.join()).toMatch(/agent-editable/i);
  });

  it("the bundled quantum-control pack passes its own integrity check", () => {
    const load = loadPacks([path.resolve(__dirname, "..", "..", "packs")]);
    expect(load.errors).toEqual([]);
    expect(load.packs.map((p) => p.manifest.id)).toContain("quantum-control");
  });
});
