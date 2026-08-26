// Handoff seeds — typed cross-campaign currency (spec-20260822 D3, issue #499).
//
// Research closes by emitting an ISSUE seed (rendered to the write-an-issue
// decision surface); dev closes by emitting a HYPOTHESIS seed (rendered to a
// vault hypothesis card). Three mechanical contracts live here:
//
//   1. SCHEMA — each seed kind has a committed JSON Schema (handoff-seeds/);
//      the copies below are the enforcement source and the test suite asserts
//      the two never drift. The seed's `kind` and its required field set are
//      bound: a fixture whose kind and field set disagree is refused (the
//      masquerade test).
//   2. EVIDENCE — pointers are vault-relative paths that must RESOLVE at
//      validation time against a root; a seed citing a nonexistent artifact —
//      or a directory, or the validation root itself, or the same artifact
//      twice — is refused, not warned.
//   3. ROUND-TRIP — seed → committed-template render → re-extract →
//      field-equal over the full declared field set. Rendering is template
//      substitution (single pass, no re-scanning), so inserted values are
//      never re-interpreted.
//
// Filing agency stays with the receiving side (protocol discipline): nothing
// here auto-files an issue or writes a card.

import { statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SuggestedTier = "chore" | "standard" | "PRD";

export interface IssueSeed {
  readonly kind: "issue";
  readonly title: string;
  readonly motivation: string;
  /** Vault-relative pointers; each must resolve under the validation root. */
  readonly evidence: readonly string[];
  readonly suggested_repo: string;
  readonly suggested_tier: SuggestedTier;
}

export interface HypothesisSeed {
  readonly kind: "hypothesis";
  readonly observation: string;
  readonly evidence: readonly string[];
  readonly suggested_experiment: string;
}

export type HandoffSeed = IssueSeed | HypothesisSeed;

/** One violated schema location. `path` is a JSON Pointer, e.g. "/evidence/1". */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export interface HandoffSeedVerdict {
  readonly ok: boolean;
  readonly seed?: HandoffSeed;
  /** Every violation, each naming its schema path. Empty iff ok. */
  readonly issues: readonly SchemaIssue[];
}

// ─── Schemas (enforcement copies of the committed handoff-seeds/ files) ──────

export interface JsonSchema {
  readonly [keyword: string]: unknown;
}

/** Single-line guard: string fields render as one template line. */
const SINGLE_LINE = "^[^\\n\\r]*$";

export const ISSUE_SEED_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "amicode:handoff-seeds/issue-seed.schema.json",
  title: "Issue handoff seed (research closes → dev picks up)",
  description:
    "Typed cross-campaign currency for a research finding that needs code. Rendered to the write-an-issue decision surface by the committed issue-seed template; filed by the receiving side through the normal issue flow. Evidence pointers are vault-relative paths that must resolve at validation time. String fields are single-line so the template render is total.",
  type: "object",
  properties: {
    kind: {
      const: "issue",
      description:
        "Fixed discriminator; bound mechanically to this field set (the masquerade test).",
    },
    title: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    motivation: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    evidence: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    },
    suggested_repo: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    suggested_tier: { enum: ["chore", "standard", "PRD"] },
  },
  required: ["kind", "title", "motivation", "evidence", "suggested_repo", "suggested_tier"],
  additionalProperties: false,
};

export const HYPOTHESIS_SEED_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "amicode:handoff-seeds/hypothesis-seed.schema.json",
  title: "Hypothesis handoff seed (dev closes → research picks up)",
  description:
    "Typed cross-campaign currency for a code-side observation that deserves an experiment. Rendered to the vault hypothesis-card convention by the committed hypothesis-seed template; filed by the receiving side into the vault. Evidence pointers are vault-relative paths that must resolve at validation time. String fields are single-line so the template render is total.",
  type: "object",
  properties: {
    kind: {
      const: "hypothesis",
      description:
        "Fixed discriminator; bound mechanically to this field set (the masquerade test).",
    },
    observation: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    evidence: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1, pattern: SINGLE_LINE },
    },
    suggested_experiment: { type: "string", minLength: 1, pattern: SINGLE_LINE },
  },
  required: ["kind", "observation", "evidence", "suggested_experiment"],
  additionalProperties: false,
};

// ─── Mini JSON-Schema engine (the subset the seed schemas use) ───────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword: the schemas are ours, nothing to check
  }
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Validate `value` against a JSON Schema (subset: type, const, enum,
 *  minLength, pattern, minItems, uniqueItems, items, properties, required,
 *  additionalProperties). Returns every violation with its JSON-Pointer path. */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = "",
): SchemaIssue[] {
  const here = path === "" ? "/" : path;
  const at = (segment: string) => `${path === "" ? "" : path}/${segment}`;
  const issues: SchemaIssue[] = [];

  const type = schema.type;
  if (typeof type === "string" && !typeMatches(value, type)) {
    return [{ path: here, message: `expected type ${type}, got ${describeType(value)}` }];
  }

  if ("const" in schema && value !== schema.const) {
    issues.push({ path: here, message: `expected const ${JSON.stringify(schema.const)}` });
  }

  const enumeration = schema.enum;
  if (Array.isArray(enumeration) && !enumeration.some((c) => c === value)) {
    issues.push({ path: here, message: `expected one of ${JSON.stringify(enumeration)}` });
  }

  if (typeof value === "string") {
    const minLength = schema.minLength;
    if (typeof minLength === "number" && value.length < minLength) {
      issues.push({ path: here, message: `shorter than minLength ${minLength}` });
    }
    const pattern = schema.pattern;
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      issues.push({ path: here, message: `does not match pattern ${pattern}` });
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === "number" && value.length < minItems) {
      issues.push({ path: here, message: `fewer than minItems ${minItems}` });
    }
    if (schema.uniqueItems === true) {
      // SameValueZero over the items — our schemas only use uniqueItems on
      // arrays of scalars, where reference identity never comes into play.
      if (new Set(value).size !== value.length) {
        issues.push({
          path: here,
          message: "array items are not unique (uniqueItems); evidence pointers are a citation set",
        });
      }
    }
    const items = schema.items;
    if (isPlainObject(items)) {
      value.forEach((item, index) => {
        issues.push(...validateAgainstSchema(item, items, `${path}/${index}`));
      });
    }
  }

  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (!(key in value)) {
          issues.push({ path: at(key), message: `required field "${key}" is missing` });
        }
      }
    }
    const properties = schema.properties;
    if (isPlainObject(properties)) {
      for (const [key, subschema] of Object.entries(properties)) {
        if (isPlainObject(subschema) && key in value) {
          issues.push(...validateAgainstSchema(value[key], subschema, at(key)));
        }
      }
    }
    if (schema.additionalProperties === false && isPlainObject(properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push({
            path: at(key),
            message: `additional property "${key}" is not allowed by this seed kind (kind/field-set disagreement)`,
          });
        }
      }
    }
  }

  return issues;
}

// ─── Validation (schema + evidence-pointer resolution) ───────────────────────

/** A pointer resolves iff it names an existing REGULAR FILE under `root`
 *  (wiki-link brackets tolerated; traversal, absolute paths, directories —
 *  including the validation root itself — refused). Evidence cites artifacts,
 *  never containers. */
function pointerResolves(root: string, pointer: string): boolean {
  const bare =
    pointer.startsWith("[[") && pointer.endsWith("]]") ? pointer.slice(2, -2) : pointer;
  const resolved = resolvePath(root, bare);
  const rootAbs = resolvePath(root);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + sep)) return false;
  return statSync(resolved, { throwIfNoEntry: false })?.isFile() === true;
}

function checkEvidencePointers(
  evidence: readonly string[],
  root: string,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  evidence.forEach((pointer, index) => {
    if (!pointerResolves(root, pointer)) {
      issues.push({
        path: `/evidence/${index}`,
        message: `evidence pointer does not resolve under the validation root: "${pointer}"`,
      });
    }
  });
  return issues;
}

function validateSeedKind(
  candidate: unknown,
  schema: JsonSchema,
  evidenceRoot: string,
): HandoffSeedVerdict {
  const issues = validateAgainstSchema(candidate, schema);
  const evidence = isPlainObject(candidate) ? candidate.evidence : undefined;
  if (Array.isArray(evidence) && evidence.every((e) => typeof e === "string")) {
    issues.push(...checkEvidencePointers(evidence as string[], evidenceRoot));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, seed: candidate as HandoffSeed, issues: [] };
}

export function validateIssueSeed(
  candidate: unknown,
  evidenceRoot: string,
): HandoffSeedVerdict {
  return validateSeedKind(candidate, ISSUE_SEED_SCHEMA, evidenceRoot);
}

export function validateHypothesisSeed(
  candidate: unknown,
  evidenceRoot: string,
): HandoffSeedVerdict {
  return validateSeedKind(candidate, HYPOTHESIS_SEED_SCHEMA, evidenceRoot);
}

/** Validate a seed of either kind; dispatch is mechanical on the `kind` field. */
export function validateHandoffSeed(
  candidate: unknown,
  evidenceRoot: string,
): HandoffSeedVerdict {
  const kind = isPlainObject(candidate) ? candidate.kind : undefined;
  if (kind === "issue") return validateIssueSeed(candidate, evidenceRoot);
  if (kind === "hypothesis") return validateHypothesisSeed(candidate, evidenceRoot);
  return {
    ok: false,
    issues: [
      {
        path: "/kind",
        message: `kind must be "issue" or "hypothesis" (got ${JSON.stringify(kind)})`,
      },
    ],
  };
}

// ─── Rendering templates (enforcement copies of handoff-seeds/*.template.md) ─

/** write-an-issue decision surface: frontmatter carries the mechanical fields,
 *  the body carries title (H1) and motivation (the Problem line). */
export const ISSUE_SEED_TEMPLATE = `---
kind: {{kind}}
suggested_repo: {{suggested_repo}}
suggested_tier: {{suggested_tier}}
evidence:
{{evidence}}
---

<!-- handoff-seed kind=issue v1 -->

# {{title}}

> [!IMPORTANT]
> **Problem** — {{motivation}}
> **Approach** — Typed handoff from a research campaign; file through the normal issue flow at the suggested tier.
> **Scope** — in: the seeded ask · out: filing agency (the receiving side files it)

## Acceptance Criteria
- [ ] The filed issue carries the seed's evidence pointers, resolved at handoff time

## Prior Art
- Evidence pointers ride the frontmatter \`evidence\` list; each resolved at validation time.

## Source
- Handoff issue seed, rendered from the committed template.
`;

/** Vault hypothesis-card convention: frontmatter (type, date, source, status,
 *  evidence, tags), body carries observation (H1) and the suggested experiment. */
export const HYPOTHESIS_SEED_TEMPLATE = `---
type: hypothesis
date: {{date}}
source: handoff-seed
status: open
evidence:
{{evidence}}
tags: [hypothesis, handoff]
---

<!-- handoff-seed kind=hypothesis v1 -->

# {{observation}}

**Suggested experiment:** {{suggested_experiment}}
`;

// ─── Render (template substitution, single pass) ─────────────────────────────

function requireSingleLine(field: string, value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error(
      `handoff seed field "${field}" must be a single line to render into the committed template`,
    );
  }
  return value;
}

function substitute(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in slots)) {
      throw new Error(`template slot {{${key}}} has no value`);
    }
    return slots[key];
  });
}

/** YAML-emit one scalar (quoted iff the value requires it). */
function yamlScalar(value: string): string {
  const emitted = stringifyYaml(value);
  return emitted.endsWith("\n") ? emitted.slice(0, -1) : emitted;
}

/** YAML-emit a block list, indented two spaces under its frontmatter key. */
function yamlList(values: readonly string[]): string {
  return stringifyYaml([...values])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderEvidence(evidence: readonly string[]): string {
  if (evidence.length === 0) {
    throw new Error("handoff seed must carry at least one evidence pointer to render");
  }
  return yamlList(evidence.map((pointer) => requireSingleLine("evidence item", pointer)));
}

export function renderIssueSeed(seed: IssueSeed, template: string = ISSUE_SEED_TEMPLATE): string {
  return substitute(template, {
    kind: "issue",
    suggested_repo: yamlScalar(requireSingleLine("suggested_repo", seed.suggested_repo)),
    suggested_tier: yamlScalar(seed.suggested_tier),
    evidence: renderEvidence(seed.evidence),
    title: requireSingleLine("title", seed.title),
    motivation: requireSingleLine("motivation", seed.motivation),
  });
}

export interface HypothesisCardOptions {
  /** Card date (ISO YYYY-MM-DD); defaults to today. Not a seed field — the
   *  extractor never reads it, so it never affects the round-trip. */
  readonly date?: string;
  readonly template?: string;
}

export function renderHypothesisSeed(
  seed: HypothesisSeed,
  options: HypothesisCardOptions = {},
): string {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  return substitute(options.template ?? HYPOTHESIS_SEED_TEMPLATE, {
    date: yamlScalar(requireSingleLine("date", date)),
    evidence: renderEvidence(seed.evidence),
    observation: requireSingleLine("observation", seed.observation),
    suggested_experiment: requireSingleLine(
      "suggested_experiment",
      seed.suggested_experiment,
    ),
  });
}

// ─── Extract (rendered artifact → seed) ──────────────────────────────────────

function splitArtifact(
  artifact: string,
  expectedGuard: string,
): { frontmatter: Record<string, unknown>; body: string } {
  if (!artifact.startsWith("---\n")) {
    throw new Error("handoff artifact must open with a YAML frontmatter block");
  }
  const end = artifact.indexOf("\n---\n", 1);
  if (end < 0) {
    throw new Error("handoff artifact frontmatter is not terminated");
  }
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(artifact.slice(4, end));
  } catch (error) {
    throw new Error(`handoff artifact frontmatter is not valid YAML: ${(error as Error).message}`);
  }
  if (!isPlainObject(frontmatter)) {
    throw new Error("handoff artifact frontmatter must be a mapping");
  }
  const body = artifact.slice(end + 5);
  if (!body.includes(expectedGuard)) {
    throw new Error(`handoff artifact is missing its template guard (${expectedGuard})`);
  }
  return { frontmatter, body };
}

function firstH1(body: string): string {
  const match = body.match(/^# (.+)$/m);
  if (!match) {
    throw new Error("handoff artifact body must carry the seed's statement as an H1");
  }
  return match[1];
}

function frontmatterEvidence(frontmatter: Record<string, unknown>): string[] {
  const evidence = frontmatter.evidence;
  if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== "string")) {
    throw new Error("handoff artifact frontmatter evidence must be a list of pointer strings");
  }
  return evidence as string[];
}

export function extractIssueSeed(artifact: string): IssueSeed {
  const { frontmatter, body } = splitArtifact(artifact, "<!-- handoff-seed kind=issue v1 -->");
  if (frontmatter.kind !== "issue") {
    throw new Error(
      `issue-seed artifact must carry kind: issue in frontmatter (got ${JSON.stringify(frontmatter.kind)})`,
    );
  }
  const problem = body.match(/^> \*\*Problem\*\* — (.*)$/m);
  if (!problem) {
    throw new Error("issue-seed artifact is missing the **Problem** line of its decision surface");
  }
  return {
    kind: "issue",
    title: firstH1(body),
    motivation: problem[1],
    evidence: frontmatterEvidence(frontmatter),
    suggested_repo: String(frontmatter.suggested_repo ?? ""),
    suggested_tier: frontmatter.suggested_tier as SuggestedTier,
  };
}

export function extractHypothesisSeed(artifact: string): HypothesisSeed {
  const { frontmatter, body } = splitArtifact(
    artifact,
    "<!-- handoff-seed kind=hypothesis v1 -->",
  );
  if (frontmatter.type !== "hypothesis") {
    throw new Error(
      `hypothesis-seed artifact must carry type: hypothesis in frontmatter (got ${JSON.stringify(frontmatter.type)})`,
    );
  }
  const experiment = body.match(/^\*\*Suggested experiment:\*\* (.*)$/m);
  if (!experiment) {
    throw new Error("hypothesis-seed artifact is missing its **Suggested experiment:** line");
  }
  return {
    kind: "hypothesis",
    observation: firstH1(body),
    evidence: frontmatterEvidence(frontmatter),
    suggested_experiment: experiment[1],
  };
}
