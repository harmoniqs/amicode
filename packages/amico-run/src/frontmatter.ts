// YAML frontmatter extraction for the deliberation Spec artifact (spec-20260728 §2.5).
//
// WHY THIS EXISTS RATHER THAN amico-validate
// ------------------------------------------
// The Spec is a vault markdown note whose frontmatter is the contract. `amico-validate`
// cannot read it: it takes `--schema` (not `--kind`), it TOML-parses anything whose
// extension is not `.json`, no package here depends on a YAML parser, and it returns exit
// 64 for BOTH a usage error and an invalid document — so a caller could not tell "the
// lens ran and the spec is bad" from "the lens could not run", which is exactly the
// distinction the review's `ran | unverified` status turns on.
//
// So the review verb extracts the frontmatter here and validates it IN-PROCESS against the
// registered `spec` schema.
//
// RETURNS A RESULT, NEVER THROWS. A malformed spec must surface as a blocking FINDING
// (exit 65) and not as a ConfigError (exit 64): the first says "your spec is wrong, here
// is what to fix", the second says "you invoked the tool wrong".
import { parse as parseYaml } from "yaml";

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** The frontmatter fence must be the FIRST line. A `---` further down is a horizontal
 *  rule or a nested document, not this note's contract — treating one as frontmatter
 *  would silently validate the wrong block. */
const OPENING = /^---[ \t]*\r?\n/;

export function parseFrontmatter(raw: string): FrontmatterResult {
  if (!OPENING.test(raw)) {
    return {
      ok: false,
      error: "no YAML frontmatter: the note must open with a `---` fence on its first line",
    };
  }
  const afterOpen = raw.replace(OPENING, "");
  // The FIRST closing fence ends the block; a later one belongs to the body.
  const close = afterOpen.search(/^---[ \t]*(\r?\n|$)/m);
  if (close === -1) {
    return { ok: false, error: "unterminated YAML frontmatter: no closing `---` fence" };
  }
  const block = afterOpen.slice(0, close);

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (e) {
    return { ok: false, error: `malformed YAML frontmatter: ${(e as Error).message}` };
  }
  if (parsed === null || parsed === undefined) {
    return { ok: false, error: "empty YAML frontmatter: expected a mapping of fields" };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `YAML frontmatter must be a mapping of fields, got ${Array.isArray(parsed) ? "a list" : typeof parsed}`,
    };
  }
  return { ok: true, data: parsed as Record<string, unknown> };
}
