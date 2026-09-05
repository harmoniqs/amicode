// skill_revision.test.ts — the typed revision contract for the public
// workflow skills (#807, spec-20260905-063000 D2): frontmatter `source` +
// `revision` (monotonic integer; missing = 0), and the supersede-path
// validation — a strictly newer vault revision is checked against the
// consumer floor AND generated-region parity BEFORE it may supersede the
// in-repo canonical copy; a mismatch declines to canonical with the NAMED
// failure (a generated-region mismatch reads generator-mismatch, never a
// staged divergent discovery rule).
import { describe, it, expect } from "vitest";
import {
  SUPPORTED_SKILL_CONTRACT_VERSION,
  KNOWN_GENERATED_REGIONS,
  parseSkillRevisionFrontmatter,
  validateSupersedingSkillRevision,
  generateLedgerDiscoveryRegion,
} from "../src/index.js";

const canonical = (body: string, fm: string = "revision: 1"): string =>
  `---\nname: director-core\ndescription: d\nsurface: public\nsource: amicode\n${fm}\n---\n\n${body}`;

describe("parseSkillRevisionFrontmatter", () => {
  it("reads revision, consumer_floor, and source from the frontmatter", () => {
    const t = canonical("# body\n", 'revision: 3\nconsumer_floor: "1"\n');
    expect(parseSkillRevisionFrontmatter(t)).toEqual({
      revision: 3,
      consumer_floor: "1",
      source: "amicode",
    });
  });
  it("a missing revision reads as 0 (D2: monotonic integer, missing = 0)", () => {
    const t = `---\nname: x\ndescription: d\nsurface: internal\n---\n\n# body\n`;
    expect(parseSkillRevisionFrontmatter(t)).toEqual({ revision: 0, consumer_floor: "0", source: null });
  });
  it("a malformed revision is a defective copy: reads as 0, never throws (skip+warn philosophy)", () => {
    const t = canonical("# body\n", "revision: two-point-oh");
    expect(parseSkillRevisionFrontmatter(t).revision).toBe(0);
  });
  it("a missing consumer_floor reads as 0 (no floor declared)", () => {
    expect(parseSkillRevisionFrontmatter(canonical("# body\n")).consumer_floor).toBe("0");
  });
});

describe("validateSupersedingSkillRevision — the consumer floor", () => {
  it("a superseding copy whose floor this build meets passes the floor", () => {
    const r = validateSupersedingSkillRevision(canonical("# body\n"), canonical("# body\n", 'revision: 2\nconsumer_floor: "1"'));
    expect(r.ok).toBe(true);
  });
  it("a superseding copy requiring a NEWER skill-stager contract declines, version-gap named", () => {
    const r = validateSupersedingSkillRevision(canonical("# body\n"), canonical("# body\n", 'revision: 2\nconsumer_floor: "2"'));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("version-gap");
    expect(r.detail).toContain("version-gap");
    expect(r.detail).toContain(SUPPORTED_SKILL_CONTRACT_VERSION);
  });
});

describe("validateSupersedingSkillRevision — generated-region parity (before it supersedes)", () => {
  const canonWithRegion = canonical(generateLedgerDiscoveryRegion());

  it("a superseding copy carrying the same region byte-exact passes", () => {
    const r = validateSupersedingSkillRevision(canonWithRegion, canonical(generateLedgerDiscoveryRegion(), "revision: 2"));
    expect(r.ok).toBe(true);
  });
  it("a superseding copy MISSING the region the canonical carries declines, generator-mismatch named", () => {
    const r = validateSupersedingSkillRevision(canonWithRegion, canonical("# body\n", "revision: 2"));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("generator-mismatch");
    expect(r.detail).toMatch(/generator-mismatch/);
    expect(r.detail).toMatch(/absent|missing/);
  });
  it("a superseding copy with a HAND-EDITED region body (current stamp forged) declines, generator-mismatch named", () => {
    const tampered = generateLedgerDiscoveryRegion().replace(
      "kickoff before any work.",
      "TAMPERED hand-edited rule body.",
    );
    const r = validateSupersedingSkillRevision(canonWithRegion, canonical(tampered, "revision: 2"));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("generator-mismatch");
    expect(r.detail).toMatch(/divergent|hand-edited/);
  });
  it("a superseding copy with an OUTDATED generator stamp declines, generator-mismatch named", () => {
    const outdated = generateLedgerDiscoveryRegion().replace("generator=v1", "generator=v0");
    const r = validateSupersedingSkillRevision(canonWithRegion, canonical(outdated, "revision: 2"));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("generator-mismatch");
    expect(r.detail).toMatch(/outdated-stamp/);
  });
  it("a superseding copy carrying a generated region this build's generator does not know declines, named (never stage what you cannot verify)", () => {
    const unknown = `<!-- AMICO-GENERATED: region=some-future-region generator=v1 begin -->\nx\n<!-- AMICO-GENERATED: region=some-future-region end -->\n`;
    const r = validateSupersedingSkillRevision(canonical("# body\n"), canonical(unknown, "revision: 2"));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("generator-mismatch");
    expect(r.detail).toContain("some-future-region");
  });
  it("the known-region set is exactly the registry's ledger-discovery-rule (the enumeration is data)", () => {
    expect(KNOWN_GENERATED_REGIONS).toEqual(["ledger-discovery-rule"]);
  });
});
