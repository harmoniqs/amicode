// Admission goldens (amicode#1743, spec-20261008-054129 §D4/B1) — the resolved
// + STAGED skill SET across entitlement and mount regimes, pinned as a golden.
//
// The suite is hermetic by construction: every library root, skill folder, and
// entitlement list is a SYNTHETIC fixture under a temp dir — no chat-DB, no
// live-machine paths, no vault mounts. The golden file (golden/admission_regimes.json)
// pins the EXPECTED staged set per regime; the fixture here builds the INPUT
// state; the REAL admission code under test (resolveLibrarySkillsWithProvenance
// → stageOpencodeSkills — the exact seam session prep drives) maps between
// them. A golden that re-implemented admission would test itself; this one
// calls the product.
//
// Regimes (issue #1743 AC1): public-only (no entitlements, no vault mount),
// entitled (entitled-surface skills present when the code is held), internal
// mount present (all internal-surface skills stage), internal mount absent
// (none stage, no crash). Leak pins (AC2/AC3): an entitled skill NEVER stages
// without its entitlement; an internal-surface skill NEVER stages without the
// mount (or from a root that does not admit internal). The least-privilege
// invariant (AC4): a process-internal skill (surface: internal, sitting in
// the public-shaped shipped library) never stages on any session surface.
//
// Goldens assert the SET (names + admission properties), never file contents
// — content linting stays the nightly freshness check's job.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveLibrarySkillsWithProvenance,
  stageOpencodeSkills,
  SKILL_DEPLOY_RECEIPT_NAME,
} from "../../src/scores/package_skills";
import type { LibraryRootSpec } from "../../src/scores/package_skills";

const GOLDEN_FILE = path.join(__dirname, "golden", "admission_regimes.json");

interface AdmissionGolden {
  regimes: Record<string, string[]>;
  never_stages_on_any_session_surface: string[];
}

function loadGolden(): AdmissionGolden {
  const raw = fs.readFileSync(GOLDEN_FILE, "utf8");
  return JSON.parse(raw) as AdmissionGolden;
}

/** The fixture entitlement code — synthetic, never a real product code. */
const ENTITLED_CODE = "issimo-gold";

type Surface = "public" | "entitled" | "internal";

function writeFixtureSkill(
  root: string,
  name: string,
  surface: Surface | null,
  entitlement?: string,
): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const surfaceLine = surface === null ? "" : `surface: ${surface}\n`;
  const entitlementLine = surface === "entitled" ? `entitlement: ${entitlement}\n` : "";
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture physics\n${surfaceLine}${entitlementLine}---\n\n# fixture body\n`,
  );
}

interface Fixture {
  /** The shipped-library-shaped root: admits {public, entitled} (ADR-0003 / ADR-0011). */
  inRepo: { path: string; surfaces: Surface[] };
  /** A vault-shaped root admitting {internal} — present on disk. */
  vaultPresent: { path: string; surfaces: Surface[] };
  /** A vault-shaped root pointing at an ABSENT dir — the unmounted-machine shape. */
  vaultAbsent: { path: string; surfaces: Surface[] };
  tmpDirs: string[];
}

/** Build the synthetic skill inventory. Two roots, one fixed inventory:
 *  - inRepo (public/entitled): atoms-gold, transmon-gold (public),
 *    piccolissimo-gold (entitled, ENTITLED_CODE), legacy-gold (untagged),
 *    pr-gold + dream-gold (surface: internal — process-internal content
 *    physically present in the public-shaped library, the leak hazard).
 *  - vaultPresent (internal): director-core-gold, write-an-issue-gold. */
function buildFixture(): Fixture {
  const inRepo = fs.mkdtempSync(path.join(os.tmpdir(), "admission-inrepo-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "admission-vault-"));
  writeFixtureSkill(inRepo, "atoms-gold", "public");
  writeFixtureSkill(inRepo, "transmon-gold", "public");
  writeFixtureSkill(inRepo, "piccolissimo-gold", "entitled", ENTITLED_CODE);
  writeFixtureSkill(inRepo, "legacy-gold", null);
  writeFixtureSkill(inRepo, "pr-gold", "internal");
  writeFixtureSkill(inRepo, "dream-gold", "internal");
  writeFixtureSkill(vault, "director-core-gold", "internal");
  writeFixtureSkill(vault, "write-an-issue-gold", "internal");
  return {
    inRepo: { path: inRepo, surfaces: ["public", "entitled"] },
    vaultPresent: { path: vault, surfaces: ["internal"] },
    vaultAbsent: { path: path.join(vault, "not-mounted"), surfaces: ["internal"] },
    tmpDirs: [inRepo, vault],
  };
}

/** One admission regime: the session's library roots + resolved entitlements. */
function regime(fx: Fixture, roots: LibraryRootSpec[], entitlements: string[]) {
  return { roots, entitlements };
}

/** Run the REAL admission pipeline for one regime and report what staged:
 *  the staged dir set, the receipt's staged names, and the resolved entries. */
function admit(fx: Fixture, roots: LibraryRootSpec[], entitlements: string[]) {
  const { entries } = resolveLibrarySkillsWithProvenance(roots, entitlements);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admission-stage-"));
  fx.tmpDirs.push(stageRoot);
  stageOpencodeSkills(stageRoot, entries, []);
  const stagedDirs = fs
    .readdirSync(stageRoot)
    .filter((n) => n !== SKILL_DEPLOY_RECEIPT_NAME)
    .sort();
  const receipt = JSON.parse(fs.readFileSync(path.join(stageRoot, SKILL_DEPLOY_RECEIPT_NAME), "utf8")) as {
    skills: Array<{ name: string; revision: number }>;
  };
  return { entries, stagedDirs, receiptSkillNames: receipt.skills.map((s) => s.name).sort() };
}

/** Assert one regime's staged set matches its pinned golden (set + admission
 *  properties). The golden key must exist — a regime without a golden entry
 *  fails loudly instead of silently passing. */
function expectRegimeGolden(key: string, observed: ReturnType<typeof admit>): void {
  const golden = loadGolden();
  const expected = golden.regimes[key];
  expect(expected, `golden regime "${key}" must be pinned in ${GOLDEN_FILE}`).toBeDefined();
  expect(observed.stagedDirs, `regime "${key}": staged set`).toEqual(expected);
  // the receipt records exactly the staged set (the audit trail matches the dirs)
  expect(observed.receiptSkillNames, `regime "${key}": receipt staged names`).toEqual(expected);
  // admission properties: every staged entry is a library entry (no package tag),
  // and its SKILL.md exists at the recorded path
  for (const e of observed.entries) {
    expect(e.source).toBe("library");
    expect(e.package).toBeUndefined();
    expect(fs.existsSync(e.path)).toBe(true);
  }
}

describe("admission goldens — the staged skill set across regimes (#1743)", () => {
  it("regime public-only (no entitlements, no vault mount): exactly the public set stages", () => {
    const fx = buildFixture();
    const observed = admit(fx, [fx.inRepo, fx.vaultAbsent], []);
    expectRegimeGolden("public-only", observed);
    // LEAK PIN (AC2 direction): the entitled skill never stages without its code
    expect(observed.stagedDirs).not.toContain("piccolissimo-gold");
    // LEAK PIN (AC3 direction): internal-surface skills never stage without the mount
    expect(observed.stagedDirs).not.toContain("director-core-gold");
    expect(observed.stagedDirs).not.toContain("write-an-issue-gold");
  });
});
