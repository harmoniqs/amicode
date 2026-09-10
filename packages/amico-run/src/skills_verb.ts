// `amico skills` — the SKILL.md validation verb (amicode#996). The `skill`
// schema (the shared schema package, the library-paper registration pattern)
// codifies what the extension's loader enforces; THIS verb walks one or more
// skill roots (a root = a dir of `<name>/SKILL.md` dirs) and validates each
// SKILL.md's frontmatter against the schema PLUS the structural rules no JSON
// schema can express:
//
//   - the frontmatter `name` must equal the folder name (the loader's and
//     opencode's name-matches-folder rule);
//   - duplicate skill names within ONE root are errors (two folders claiming
//     the same identity). Across roots a repeated name is the NORMAL typed
//     revision-selection case (an in-repo canonical + a vault superseding
//     copy), so it is not the verb's business.
//
// `check` with no --roots validates the three fleet surfaces (the freshness
// cadence's roots, amicode#587): the repo's shipped public library, the
// armonissima vault library, the server staged set. Honest degradation, the
// freshness script's posture: an absent root is reported as skipped, never a
// crash; the exit code is driven by INVALID SKILLS ONLY.
//
// Read-only by construction: pure filesystem + registry validation — no
// network, no LLM, no running server (the drift lint's no-network doctrine).
// Frontmatter parsing routes through the ONE shared amico-run reader
// (frontmatter.ts), the same parser the spec lens uses, so the verb agrees
// with the extension loader (yaml frontmatter between `---` fences) on what
// parses.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validate } from "@amicode/schema";
import { parseFrontmatter } from "./frontmatter.js";
import type { VerbResult } from "./verbs.js";

interface InvalidSkill {
  skill: string; // the folder name
  path: string; // the SKILL.md path
  reasons: string[]; // field-precise, named
}

interface RootReport {
  label: string; // "public" | "internal" | "staging" | "root"
  root: string;
  status: "ok" | "skipped";
  scanned: number;
  valid: number;
  invalid: number;
  invalid_details?: InvalidSkill[];
  reason?: string; // why a skipped root was skipped
}

/** Flag parser: `--roots` is VARIADIC — it consumes every following non-flag
 *  argument, and the flag itself is repeatable, so both `--roots a b` and
 *  `--roots a --roots b` work (the drift-lint CLI's flag shape). */
function rootsFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--roots") {
      for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("--"); j++) out.push(argv[j]!);
    }
  }
  return out;
}

/** Scan ONE skill root (a dir of `<name>/SKILL.md` dirs): every dir holding a
 *  SKILL.md is scanned (loader discovery parity — a dir without one is not a
 *  skill and is not counted), its frontmatter parsed by the shared reader and
 *  validated against the `skill` schema, then the structural rules applied.
 *  Never throws: an unreadable root degrades to a skipped report. */
function scanRoot(label: string, root: string): RootReport {
  const base: RootReport = { label, root, status: "ok", scanned: 0, valid: 0, invalid: 0 };
  if (!existsSync(root)) return { ...base, status: "skipped", reason: "absent" };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { ...base, status: "skipped", reason: `unreadable: ${(e as Error).message}` };
  }
  const seen = new Map<string, string>(); // frontmatter name → first SKILL.md path
  const invalid_details: InvalidSkill[] = [];
  for (const entry of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const skillPath = join(root, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue; // not a skill dir — loader discovery parity
    base.scanned++;
    const reasons: string[] = [];
    let fm: Record<string, unknown> | undefined;
    try {
      const parsed = parseFrontmatter(readFileSync(skillPath, "utf8"));
      if (parsed.ok) fm = parsed.data;
      else reasons.push(parsed.error);
    } catch (e) {
      reasons.push(`cannot read: ${(e as Error).message}`);
    }
    if (fm !== undefined) {
      for (const err of validate(fm, "skill").errors) reasons.push(`schema: ${err}`);
      const name = fm.name;
      if (typeof name !== "string" || name === "") {
        reasons.push("no usable frontmatter name to compare against the folder name");
      } else {
        if (name !== entry) reasons.push(`frontmatter name "${name}" does not equal the folder name "${entry}"`);
        const first = seen.get(name);
        if (first !== undefined) reasons.push(`duplicate skill name "${name}" (also at ${first})`);
        else seen.set(name, skillPath);
      }
    }
    if (reasons.length === 0) base.valid++;
    else {
      base.invalid++;
      invalid_details.push({ skill: entry, path: skillPath, reasons });
    }
  }
  return base.invalid === 0 ? base : { ...base, invalid_details };
}

/** The `check` body: validate the given (or default) skill roots. Exit 0 on
 *  clean (or all-skipped), 1 if any skill is invalid, 64 on usage error. */
export function skillsCheck(argv: string[]): VerbResult {
  const explicit = rootsFlags(argv);
  const roots: Array<{ label: string; path: string }> =
    explicit.length > 0 ? explicit.map((p) => ({ label: "root", path: p })) : defaultRoots();
  const reports = roots.map((r) => scanRoot(r.label, r.path));
  const invalid = reports.reduce((n, r) => n + r.invalid, 0);
  const scanned = reports.reduce((n, r) => n + r.scanned, 0);
  const valid = reports.reduce((n, r) => n + r.valid, 0);
  return {
    json: {
      verb: "skills",
      subcommand: "check",
      ok: invalid === 0,
      roots: reports,
      scanned,
      valid,
      invalid,
    },
    code: invalid === 0 ? 0 : 1,
  };
}

/** The three fleet surfaces the no-arg check validates (the freshness
 *  cadence's roots, amicode#587): the repo's shipped public library, the
 *  armonissima vault library, the server staged set. Every path is
 *  injectable via env so CI and tests point at fixture trees; the repo root
 *  self-disables wherever the checkout layout is absent (the profile verb's
 *  pattern), and an absent root degrades to skipped at scan time. */
function defaultRoots(): Array<{ label: string; path: string }> {
  return [
    { label: "public", path: repoSkillsRoot() },
    {
      label: "internal",
      path: process.env.AMICO_SKILLS_VAULT ?? join(homedir(), ".amico", "vaults", "armonissima", "skills"),
    },
    {
      label: "staging",
      path:
        process.env.AMICO_SKILLS_STAGING ??
        join(homedir(), ".amico", "server", "opencode-project-staging", "opencode-project", "skills"),
    },
  ];
}

/** The repo's shipped public library: env override first (tests, CI), then
 *  the installed-bundle layout (bin/dist/amico.js → ../../skills), then the
 *  in-repo source layout (packages/amico-run/src → packages/extension/skills),
 *  then the fleet server's canonical checkout (the freshness script's
 *  default). First EXISTING candidate wins; none → the freshness default path
 *  (reported skipped when absent). */
function repoSkillsRoot(): string {
  const env = process.env.AMICO_SKILLS_REPO;
  if (env && env.trim() !== "") return env;
  const script = process.argv[1];
  if (script) {
    for (const cand of [
      resolve(dirname(script), "..", "..", "skills"), // installed bundle layout
      resolve(dirname(script), "..", "..", "extension", "skills"), // in-repo source layout
    ]) {
      if (existsSync(cand)) return cand;
    }
  }
  return join(homedir(), "armonia", "repos", "amicode", "packages", "extension", "skills");
}

// ── subcommand router ────────────────────────────────────────────────────────────
/** The `skills` verb body: route on the subcommand. Backs BOTH the CLI
 *  (amico.ts — SPINE_VERBS dispatch) and the MCP facade (mcp_serve.ts — the
 *  registry auto-publishes `amico_skills`): one impl, two transports. */
export function skillsVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  if (sub === "check") return skillsCheck(argv.slice(1));
  return {
    json: {
      verb: "skills",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico skills check [--roots <dir> [<dir>…]]",
    },
    code: 64,
  };
}
