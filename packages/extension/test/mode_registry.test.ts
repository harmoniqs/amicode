// mode_registry.test.ts — H1, the shared bundle validator (#804, spec
// D1 / mode_schema_enforced): the director-mode bundles under
// packages/extension/modes/ are typed data — ONE validator, imported here
// (vitest) and by the amico-run doctor probe, so a bundle that passes tests
// passes the probe.
//
// Declared-set rule: a bundle may ship fewer roles/skills only by EXPLICIT
// manifest declaration — a bundle missing any DECLARED component, phase,
// gate, role, handoff-seed, or file fails validation, here and in the doctor.
//
// The ledger-discovery-rule generated region (AC8): delimited, stamped,
// byte-identical across card, skill fixture, and the registry generator; the
// stamp CLASSIFIES mismatches (regenerate-and-compare detects) and never
// authorizes a pass — a forged current-version stamp still fails.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateModeBundle,
  validateModeRegistry,
  validateGatePack,
  parseModeManifest,
  generateLedgerDiscoveryRegion,
  classifyLedgerDiscoveryRegion,
  checkConsumerFloor,
  parseReleaseIndex,
  compareReleaseToIndex,
  MODE_GENERATOR_VERSION,
  type ModeBundleValidation,
} from "@amicode/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");
const MODES_DIR = join(EXT, "modes");
const AGENTS_DIR = join(EXT, "agents");
const SKILL_FIXTURE = join(EXT, "skills", "director-core", "SKILL.md"); // the in-repo canonical copy (#807) — what the vsix ships and the tests pin

/** The shipped bundles, copied to a temp tree so missing-component cells can
 *  delete pieces without touching the real registry. */
function bundleCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "mode-registry-fixture-"));
  const extRoot = join(root, "extension");
  mkdirSync(extRoot, { recursive: true });
  cpSync(MODES_DIR, join(extRoot, "modes"), { recursive: true });
  // the manifest's declared paths resolve OUTSIDE the bundle (../../agents,
  // ../../handoff-seeds) — copy those too so the copy validates like the real
  // tree.
  cpSync(AGENTS_DIR, join(extRoot, "agents"), { recursive: true });
  cpSync(join(EXT, "handoff-seeds"), join(extRoot, "handoff-seeds"), { recursive: true });
  return extRoot;
}

function validationOk(v: ModeBundleValidation): void {
  expect(v.errors, v.errors.join("\n")).toEqual([]);
  expect(v.ok).toBe(true);
}

describe("the shipped registry validates (one validator, two consumers)", () => {
  it("validateModeRegistry: both bundles valid, zero errors", () => {
    validationOk(validateModeRegistry(MODES_DIR, EXT));
  });

  it("each bundle validates on its own too", () => {
    validationOk(validateModeBundle(join(MODES_DIR, "autodev"), { extensionRoot: EXT }));
    validationOk(validateModeBundle(join(MODES_DIR, "autoresearch"), { extensionRoot: EXT }));
  });

  it("the modes directory holds exactly the two director bundles + the release index", () => {
    expect(readdirSync(MODES_DIR).sort()).toEqual(["autodev", "autoresearch", "release-index.toml"]);
  });
});

describe("bundle card parity (legacy staging stays authoritative — AC9)", () => {
  it("each bundle card.md is byte-identical to the legacy agents/ card it mirrors", () => {
    for (const mode of ["autodev", "autoresearch"]) {
      expect(readFileSync(join(MODES_DIR, mode, "card.md"), "utf8")).toBe(
        readFileSync(join(AGENTS_DIR, `${mode}.md`), "utf8"),
      );
    }
  });
});

describe("a bundle missing a DECLARED component fails (declared-set, AC1)", () => {
  it("missing pack.toml → fails, named", () => {
    const root = bundleCopy();
    rmSync(join(root, "modes", "autodev", "pack.toml"));
    const v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /pack\.toml/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("missing manifest-declared role file → fails, role named", () => {
    const root = bundleCopy();
    rmSync(join(root, "agents", "implementer.md"));
    const v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /implementer/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("missing handoff-seed schema → fails, seed named", () => {
    const root = bundleCopy();
    rmSync(join(root, "handoff-seeds", "issue-seed.schema.json"));
    const v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /issue-seed\.schema\.json/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("missing card.md → fails, named", () => {
    const root = bundleCopy();
    rmSync(join(root, "modes", "autoresearch", "card.md"));
    const v = validateModeBundle(join(root, "modes", "autoresearch"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /card\.md/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("a pack phase with zero gates fails the gate-pack schema (declared phases carry gates)", () => {
    const v = validateGatePack(
      'closing_artifact = "x"\n\n[[phases]]\nname = "decompose"\n\n[[handoffs]]\nkind = "issue_seed"\ntarget = "autodev"\n',
    );
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /gates/.test(e))).toBe(true);
  });

  it("declared-set consistency: a manifest role absent from the pack fails; a pack role undeclared in the manifest fails", () => {
    // manifest declares a role the pack never casts
    const root = bundleCopy();
    const manifestPath = join(root, "modes", "autodev", "mode.toml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(
      'name = "implementer"',
      'name = "librarian"\npath = "../../agents/librarian.md"',
    ));
    let v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /librarian/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });

    // the pack casts a role the manifest never declares
    const root2 = bundleCopy();
    const packPath = join(root2, "modes", "autoresearch", "pack.toml");
    writeFileSync(packPath, readFileSync(packPath, "utf8").replace('roles = ["analyzer"]', 'roles = ["analyzer", "librarian"]'));
    v = validateModeBundle(join(root2, "modes", "autoresearch"), { extensionRoot: root2 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /librarian/.test(e))).toBe(true);
    rmSync(root2, { recursive: true, force: true });
  });

  it("cross-bundle handoff consistency: a pack handoff's target must be a registry mode that declares the seed kind", () => {
    // corrupt the dev pack's handoff to target a mode that does not exist
    const root = bundleCopy();
    writeFileSync(
      join(root, "modes", "autodev", "pack.toml"),
      readFileSync(join(root, "modes", "autodev", "pack.toml"), "utf8").replace('target = "autoresearch"', 'target = "nonexistent-mode"'),
    );
    const v = validateModeRegistry(join(root, "modes"), root);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /nonexistent-mode/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("a malformed manifest fails the manifest schema with named errors", () => {
    const root = bundleCopy();
    writeFileSync(join(root, "modes", "autodev", "mode.toml"), 'schema_version = "99"\nmode = "autodev"\n');
    const v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /schema_version/.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the ledger-discovery-rule generated region (AC8)", () => {
  const region = generateLedgerDiscoveryRegion();

  it("the generator emits a delimited region stamped with the generator version", () => {
    expect(region).toContain(`region=ledger-discovery-rule generator=${MODE_GENERATOR_VERSION}`);
    expect(region.startsWith("<!-- AMICO-GENERATED")).toBe(true);
    expect(region.trimEnd().endsWith("-->")).toBe(true);
  });

  it("both bundle cards carry the region byte-identical to the generator", () => {
    for (const mode of ["autodev", "autoresearch"]) {
      const card = readFileSync(join(MODES_DIR, mode, "card.md"), "utf8");
      expect(classifyLedgerDiscoveryRegion(card).status).toBe("ok");
      expect(card).toContain(region);
    }
  });

  it("the region's rule block is byte-identical to the director-core canonical skill's block (card ≡ skill ≡ registry) — and the skill itself carries the delimited generated region (AC8 deferred leg, #807)", () => {
    const skill = readFileSync(SKILL_FIXTURE, "utf8");
    const open = skill.lastIndexOf("```text", skill.indexOf("LEDGER DISCOVERY RULE v1"));
    const close = skill.indexOf("```", open + "```text".length);
    const skillBlock = skill.slice(open, close + 3);
    expect(region).toContain(skillBlock);
    for (const mode of ["autodev", "autoresearch"]) {
      const card = readFileSync(join(MODES_DIR, mode, "card.md"), "utf8");
      expect(card).toContain(skillBlock);
    }
    // the deferred AC8 leg: the skill's region is delimited + generator-stamped,
    // byte-identical to the generator output — parity extends to the skill.
    expect(classifyLedgerDiscoveryRegion(skill).status).toBe("ok");
    expect(skill).toContain(region);
  });

  it("classification: a missing region is a named mismatch", () => {
    const card = readFileSync(join(MODES_DIR, "autodev", "card.md"), "utf8");
    const c = classifyLedgerDiscoveryRegion(card.replace(region, ""));
    expect(c.status).toBe("missing");
  });

  it("classification: an outdated stamp is a named mismatch (regenerate-and-compare detects)", () => {
    const card = readFileSync(join(MODES_DIR, "autodev", "card.md"), "utf8");
    const c = classifyLedgerDiscoveryRegion(
      card.replace(`generator=${MODE_GENERATOR_VERSION}`, "generator=v0"),
    );
    expect(c.status).toBe("outdated-stamp");
  });

  it("the stamp never authorizes a pass: a FORGED current stamp over divergent bytes still fails", () => {
    const card = readFileSync(join(MODES_DIR, "autodev", "card.md"), "utf8");
    const tampered = card.replace(
      "Path convention — the session ledger lives in the personal vault at",
      "Path convention — TAMPERED hand-edited region body",
    );
    // the tampered card still carries the CURRENT generator stamp
    expect(tampered).toContain(`generator=${MODE_GENERATOR_VERSION}`);
    const c = classifyLedgerDiscoveryRegion(tampered);
    expect(c.status).toBe("divergent");
    // and the bundle validator refuses it
    const root = bundleCopy();
    writeFileSync(join(root, "modes", "autodev", "card.md"), tampered);
    const v = validateModeBundle(join(root, "modes", "autodev"), { extensionRoot: root });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /generated region|divergent|ledger-discovery/i.test(e))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("an unmarked hand-edited region body (delimiters stripped) is the missing case, never a pass", () => {
    const card = readFileSync(join(MODES_DIR, "autodev", "card.md"), "utf8");
    const stripped = card.replace(/<!-- AMICO-GENERATED[^\n]*-->\n/g, "");
    expect(classifyLedgerDiscoveryRegion(stripped).status).toBe("missing");
  });
});

describe("version floors (AC5 — per-consumer floor map)", () => {
  const floors = parseModeManifest(readFileSync(join(MODES_DIR, "autodev", "mode.toml"), "utf8")).consumer_floors;
  const CONSUMERS = ["doctor", "plugin", "stager", "tests"] as const;

  it("the shipped manifest carries a floor for every consumer kind", () => {
    for (const c of CONSUMERS) expect(floors[c]).toBeDefined();
  });

  it("a consumer at the floor passes", () => {
    for (const c of CONSUMERS) expect(checkConsumerFloor(floors, c, floors[c]).ok).toBe(true);
  });

  it("a consumer below the floor fails LOUDLY (named, never silent)", () => {
    const r = checkConsumerFloor(floors, "doctor", "0");
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("version-gap");
    expect(r.consumer).toBe("doctor");
    expect(r.render).toMatch(/version gap/);
  });

  it("a PLUGIN-side gap renders the explicit unresolvable block, never silence", () => {
    const r = checkConsumerFloor(floors, "plugin", "0");
    expect(r.ok).toBe(false);
    expect(r.render).toMatch(/unresolvable/i);
    expect(r.render.length).toBeGreaterThan(0);
  });
});

describe("the release index (AC6 — vsix-tag → registry-revision)", () => {
  const INDEX = `
schema_version = "1"

[[releases]]
vsix_tag = "v0.3.1"
registry_revision = 0

[[releases]]
vsix_tag = "v0.3.2"
registry_revision = 1
`;

  it("the committed index parses and validates", () => {
    const parsed = parseReleaseIndex(readFileSync(join(MODES_DIR, "release-index.toml"), "utf8"));
    expect(parsed.releases.length).toBeGreaterThan(0);
    for (const r of parsed.releases) expect(r.registry_revision).toBeGreaterThanOrEqual(0);
  });

  it("a machine at the newest release reads current-to-release", () => {
    const c = compareReleaseToIndex("0.3.2", parseReleaseIndex(INDEX));
    expect(c.status).toBe("current");
    expect(c.machine_release).toBe("v0.3.2");
  });

  it("a machine a release behind reads `current to vX, stale to release vY`", () => {
    const c = compareReleaseToIndex("0.3.1", parseReleaseIndex(INDEX));
    expect(c.status).toBe("stale-to-release");
    expect(c.machine_release).toBe("v0.3.1");
    expect(c.newest_release).toBe("v0.3.2");
    expect(c.render).toContain("current to v0.3.1");
    expect(c.render).toContain("stale to release v0.3.2");
  });

  it("a PRE-REGISTRY machine (revision 0) reads stale-to-release, never current", () => {
    const c = compareReleaseToIndex("0.3.1", parseReleaseIndex(INDEX));
    expect(c.status).toBe("stale-to-release");
  });

  it("an untagged/dev build renders a NAMED unknown, never a verdict", () => {
    const c = compareReleaseToIndex("0.0.0-local.2099010100", parseReleaseIndex(INDEX));
    expect(c.status).toBe("untagged-unknown");
    expect(c.render).toMatch(/untagged|dev build/i);
  });

  it("an unparseable index is a named invalid, never a silent default", () => {
    expect(() => parseReleaseIndex("not toml {")).toThrow(/release index/);
  });
});

describe("gate packs validate through the shared schema (re-homed)", () => {
  it("both shipped packs pass validateGatePack", () => {
    for (const mode of ["autodev", "autoresearch"]) {
      const pack = readFileSync(join(MODES_DIR, mode, "pack.toml"), "utf8");
      const v = validateGatePack(pack);
      validationOk(v as unknown as ModeBundleValidation);
    }
  });

  it("a pack with an unknown gate kind fails, named", () => {
    const v = validateGatePack('closing_artifact = "x"\n\n[[phases]]\nname = "p"\n\n  [[phases.gates]]\n  name = "g"\n  kind = "vibes"\n  owner = "o"\n  procedure = "x"\n');
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /kind/.test(e))).toBe(true);
  });
});
