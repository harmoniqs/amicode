// Handoff seeds (#499) — spec-20260822 D3 + Measurement Protocol `handoff_roundtrip_pass`.
//
// Cross-campaign handoffs are typed artifacts: an ISSUE seed (research → dev,
// rendered to the write-an-issue decision surface) and a HYPOTHESIS seed
// (dev → research, rendered to a vault hypothesis card). The contract under
// test: every valid fixture parses against its committed schema AND round-trips
// — seed → committed-template render → re-extract → field-equal over the full
// declared field set. Adversarial fixtures are REFUSED, never warned, with the
// violated schema path named: dead evidence pointers, the kind/field-set
// masquerade, missing required fields, and (reviewer pass) traversal and
// absolute pointers, directory/root pointers, duplicate citations,
// cross-kind contamination on an otherwise-complete seed, and empty fields.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateHandoffSeed,
  renderIssueSeed,
  extractIssueSeed,
  renderHypothesisSeed,
  extractHypothesisSeed,
  ISSUE_SEED_SCHEMA,
  HYPOTHESIS_SEED_SCHEMA,
  ISSUE_SEED_TEMPLATE,
  HYPOTHESIS_SEED_TEMPLATE,
  type IssueSeed,
  type HypothesisSeed,
} from "../src/handoff_seeds";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "fixtures/handoff-seeds");
const evidenceRoot = path.join(fixtureDir, "root");
const contractDir = path.resolve(here, "../handoff-seeds");

const read = (absolute: string): string => readFileSync(absolute, "utf8");
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(fixtureDir, rel), "utf8"));

const jsonFiles = (rel: string): string[] =>
  readdirSync(path.join(fixtureDir, rel))
    .filter((name) => name.endsWith(".json"))
    .sort();

// A fixed card date so hypothesis renders are byte-deterministic in tests;
// the date is card furniture, never a seed field, so it cannot skew equality.
const CARD_DATE = "2026-08-23";

describe("handoff seeds (#499): valid issue seeds parse + round-trip", () => {
  for (const name of jsonFiles("valid").filter((n) => n.startsWith("issue-"))) {
    it(`issue seed ${name} validates and round-trips field-equal`, () => {
      const seed = readJson(`valid/${name}`) as IssueSeed;

      const verdict = validateHandoffSeed(seed, evidenceRoot);
      expect(verdict.issues).toEqual([]);
      expect(verdict.ok).toBe(true);

      const extracted = extractIssueSeed(renderIssueSeed(seed));
      expect(extracted).toEqual(seed); // full declared field set, exact values
      expect(Object.keys(extracted).sort()).toEqual([
        "evidence",
        "kind",
        "motivation",
        "suggested_repo",
        "suggested_tier",
        "title",
      ]);

      // the re-extracted seed is itself a valid seed — the loop closes
      expect(validateHandoffSeed(extracted, evidenceRoot).ok).toBe(true);
    });
  }
});

describe("handoff seeds (#499): valid hypothesis seeds parse + round-trip", () => {
  for (const name of jsonFiles("valid").filter((n) => n.startsWith("hypothesis-"))) {
    it(`hypothesis seed ${name} validates and round-trips field-equal`, () => {
      const seed = readJson(`valid/${name}`) as HypothesisSeed;

      const verdict = validateHandoffSeed(seed, evidenceRoot);
      expect(verdict.issues).toEqual([]);
      expect(verdict.ok).toBe(true);

      const extracted = extractHypothesisSeed(
        renderHypothesisSeed(seed, { date: CARD_DATE }),
      );
      expect(extracted).toEqual(seed); // full declared field set, exact values
      expect(Object.keys(extracted).sort()).toEqual([
        "evidence",
        "kind",
        "observation",
        "suggested_experiment",
      ]);

      expect(validateHandoffSeed(extracted, evidenceRoot).ok).toBe(true);
    });
  }
});

describe("handoff seeds (#499): adversarial refusals name the violated path", () => {
  const adversarial = (name: string): unknown => readJson(`adversarial/${name}`);
  const pathsOf = (name: string): string[] => {
    const verdict = validateHandoffSeed(adversarial(name), evidenceRoot);
    expect(verdict.ok).toBe(false); // refused, never warned
    expect(verdict.seed).toBeUndefined();
    expect(verdict.issues.length).toBeGreaterThan(0);
    return verdict.issues.map((issue) => issue.path);
  };

  it("dead evidence pointer is refused, naming the pointer's index", () => {
    expect(pathsOf("issue-dead-evidence-pointer.json")).toContain("/evidence/1");
  });

  it("masquerade: kind issue without suggested_repo is refused, naming the field", () => {
    // the masquerade is MECHANICAL: kind "issue" is itself well-formed, but the
    // field set is a hypothesis's — the kind/field-set disagreement surfaces as
    // the missing issue-required fields plus foreign hypothesis fields.
    const paths = pathsOf("issue-masquerade-no-repo.json");
    expect(paths).toContain("/suggested_repo");
    expect(paths).toContain("/title"); // issue-required fields the shape lacks
    expect(paths).toContain("/suggested_experiment"); // foreign field, refused
  });

  it("masquerade: kind hypothesis without suggested_experiment is refused, naming the field", () => {
    const paths = pathsOf("hypothesis-masquerade-no-experiment.json");
    expect(paths).toContain("/suggested_experiment");
    expect(paths).toContain("/observation"); // hypothesis-required, absent
    expect(paths).toContain("/suggested_repo"); // foreign field, refused
  });

  it("missing required field is refused, naming the field", () => {
    expect(pathsOf("hypothesis-missing-evidence.json")).toContain("/evidence");
  });

  // ── reviewer pass 2026-08-23: adversarial variants born from live probing ──

  it("wiki-link traversal escaping the root is refused at the pointer's index", () => {
    expect(pathsOf("issue-traversal-wikilink.json")).toContain("/evidence/0");
  });

  it("absolute-path and bare-traversal evidence pointers are refused, each at its index", () => {
    const paths = pathsOf("issue-absolute-path-evidence.json");
    expect(paths).toContain("/evidence/0");
    expect(paths).toContain("/evidence/1");
  });

  it("an empty string field is refused, naming the field (not just missing ones)", () => {
    expect(pathsOf("hypothesis-empty-experiment.json")).toContain("/suggested_experiment");
  });

  it("an otherwise-COMPLETE issue seed carrying a foreign hypothesis field is refused (cross-kind contamination)", () => {
    // unlike the masquerade fixtures, every issue-required field is present
    // here — the ONLY tell is the foreign field, so this pins
    // additionalProperties as an independent refusal reason.
    expect(pathsOf("issue-foreign-field.json")).toContain("/suggested_experiment");
  });

  it("evidence pointers naming directories are refused — evidence cites artifacts, not containers", () => {
    // both spellings: wiki-link bracketed and trailing-slash
    const paths = pathsOf("hypothesis-directory-evidence.json");
    expect(paths).toContain("/evidence/0");
    expect(paths).toContain("/evidence/1");
  });

  it("an evidence pointer naming the validation root itself is refused", () => {
    expect(pathsOf("issue-root-self-evidence.json")).toContain("/evidence/0");
  });

  it("duplicate evidence pointers are refused at /evidence (the list is a citation set)", () => {
    expect(pathsOf("hypothesis-duplicate-evidence.json")).toContain("/evidence");
  });

  it("a seed whose kind is neither issue nor hypothesis is refused at /kind", () => {
    const verdict = validateHandoffSeed({ kind: "note", evidence: [] }, evidenceRoot);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.map((issue) => issue.path)).toEqual(["/kind"]);
  });
});

describe("handoff seeds (#499): the committed contract is the enforcement copy", () => {
  it("handoff-seeds/issue-seed.schema.json equals the embedded issue schema", () => {
    expect(JSON.parse(read(path.join(contractDir, "issue-seed.schema.json")))).toEqual(
      ISSUE_SEED_SCHEMA,
    );
  });

  it("handoff-seeds/hypothesis-seed.schema.json equals the embedded hypothesis schema", () => {
    expect(JSON.parse(read(path.join(contractDir, "hypothesis-seed.schema.json")))).toEqual(
      HYPOTHESIS_SEED_SCHEMA,
    );
  });

  it("handoff-seeds/issue-seed.template.md is the render source for issue seeds", () => {
    const seed = readJson("valid/issue-detector-thresholds.json") as IssueSeed;
    const fileTemplate = read(path.join(contractDir, "issue-seed.template.md"));
    expect(renderIssueSeed(seed, fileTemplate)).toBe(renderIssueSeed(seed));
  });

  it("handoff-seeds/hypothesis-seed.template.md is the render source for hypothesis seeds", () => {
    const seed = readJson("valid/hypothesis-blockade-rank.json") as HypothesisSeed;
    const fileTemplate = read(path.join(contractDir, "hypothesis-seed.template.md"));
    expect(renderHypothesisSeed(seed, { date: CARD_DATE, template: fileTemplate })).toBe(
      renderHypothesisSeed(seed, { date: CARD_DATE }),
    );
  });

  it("the embedded templates match the committed files byte-for-byte", () => {
    expect(read(path.join(contractDir, "issue-seed.template.md"))).toBe(ISSUE_SEED_TEMPLATE);
    expect(read(path.join(contractDir, "hypothesis-seed.template.md"))).toBe(
      HYPOTHESIS_SEED_TEMPLATE,
    );
  });
});

describe("handoff seeds (#499): corpus floors (Measurement Protocol)", () => {
  it("≥ 4 valid fixtures, ≥ 2 per seed kind", () => {
    const valid = jsonFiles("valid");
    expect(valid.filter((n) => n.startsWith("issue-")).length).toBeGreaterThanOrEqual(2);
    expect(valid.filter((n) => n.startsWith("hypothesis-")).length).toBeGreaterThanOrEqual(2);
    expect(valid.length).toBeGreaterThanOrEqual(4);
  });

  it("≥ 3 adversarial fixtures", () => {
    expect(jsonFiles("adversarial").length).toBeGreaterThanOrEqual(3);
  });
});

describe("handoff seeds (#499): zero blocklisted strings in committed slice files", () => {
  // The proper-noun blocklist (spec D4), assembled from fragments so that THIS
  // file never contains the strings contiguously — it greps itself too.
  const BLOCKLIST = [
    "tel" + "aio",
    "Piccol" + "issimo",
    "Alt" + "issimo",
    "harmo" + "niqs",
    "spar" + "tito",
  ];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : [p];
    });

  const sliceFiles = [
    path.join(contractDir, "issue-seed.schema.json"),
    path.join(contractDir, "hypothesis-seed.schema.json"),
    path.join(contractDir, "issue-seed.template.md"),
    path.join(contractDir, "hypothesis-seed.template.md"),
    path.resolve(here, "../src/handoff_seeds.ts"),
    path.join(here, "handoff_seeds.test.ts"),
    ...walk(fixtureDir),
  ];

  it("no committed slice file carries a blocklisted proper noun", () => {
    expect(sliceFiles.length).toBeGreaterThan(6);
    const violations: string[] = [];
    for (const file of sliceFiles) {
      const content = read(file);
      for (const banned of BLOCKLIST) {
        if (content.includes(banned)) {
          violations.push(`${path.relative(here, file)}: contains a blocklisted proper noun`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("handoff seeds (#499): render targets", () => {
  const issueSeed = readJson("valid/issue-detector-thresholds.json") as IssueSeed;
  const hypothesisSeed = readJson("valid/hypothesis-blockade-rank.json") as HypothesisSeed;

  it("issue-seed render IS the write-an-issue decision surface", () => {
    const artifact = renderIssueSeed(issueSeed);
    expect(artifact).toContain("> [!IMPORTANT]");
    expect(artifact).toContain("**Problem** — ");
    expect(artifact).toContain("## Acceptance Criteria");
    expect(artifact).toContain("## Prior Art");
  });

  it("hypothesis-seed render IS the vault hypothesis card", () => {
    const artifact = renderHypothesisSeed(hypothesisSeed, { date: CARD_DATE });
    expect(artifact).toContain("type: hypothesis");
    expect(artifact).toContain(`date: ${CARD_DATE}`);
    expect(artifact).toContain("source: handoff-seed");
    expect(artifact).toContain("status: open");
    expect(artifact).toContain("tags: [hypothesis, handoff]");
  });
});
