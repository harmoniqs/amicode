import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml"; // same parser as scores/loader.ts

// Dual-source skill index (spec-20260704-113005 §1/§3). Two skill TYPES:
//   - PACKAGE skills: co-located at packages/<P>.jl/skills/<name>/SKILL.md,
//     discovered ONLY for entitlement-allowlisted packages (gated).
//   - PLATFORM skills: cross-package physics refs in the central amico-plugin
//     library, discovered by an explicit CONFIGURED NAME LIST (public), never a
//     whole-dir scan — the library holds ~50 process skills that must not leak.
// Content is read on demand by the agent — never baked into the prompt or the
// .vsix. Errors mirror the entitlements philosophy: skip + warn, never throw.
export interface SkillIndexEntry {
  source: "library" | "package"; // platform library (public) vs co-located package skill (gated)
  package?: string; // absent for library entries (spec §3)
  name: string;
  description: string;
  path: string; // absolute SKILL.md path
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  return p;
}

/** Parse a SKILL.md's frontmatter; throw on anything malformed (caller skips). */
function readFrontmatter(skillPath: string): { name: string; description: string } {
  const raw = fs.readFileSync(skillPath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("missing frontmatter");
  const fm = parseYaml(m[1]) as { name?: string; description?: string };
  if (typeof fm.name !== "string" || typeof fm.description !== "string")
    throw new Error("frontmatter needs name + description");
  return { name: fm.name, description: fm.description };
}

/** Package skills for allowlisted packages (gated). First root containing
 *  `<P>.jl/skills` wins. Missing repo / no skills dir → silently skipped. */
export function resolvePackageSkills(allowlist: string[], roots: string[]): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  for (const pkg of allowlist) {
    const skillsDir = roots
      .map((r) => path.join(expandHome(r), `${pkg}.jl`, "skills"))
      .find((d) => {
        try {
          return fs.statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
    if (!skillsDir) continue; // no repo / no skills — silently skipped (spec §9)
    let names: string[] = [];
    try {
      names = fs.readdirSync(skillsDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const skillPath = path.join(skillsDir, name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      try {
        const fm = readFrontmatter(skillPath);
        out.push({ source: "package", package: pkg, name: fm.name, description: fm.description, path: skillPath });
      } catch (e) {
        console.warn(`amicode: skipping malformed skill ${skillPath}: ${e}`); // never dead-end (spec §9)
      }
    }
  }
  return out;
}

/** Platform skills from the central library (spec §3, Rev 2). PUBLIC by
 *  construction — NO entitlement input. Only the CONFIGURED names are looked
 *  up: the library dir also holds ~50 process skills that must never leak into
 *  the Amicode prompt (explicit list is the guard; marker-based discovery is a
 *  recorded follow-up). First root containing `<name>/SKILL.md` wins. */
export function resolveLibrarySkills(names: string[], roots: string[]): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  for (const name of names) {
    const skillPath = roots.map((r) => path.join(expandHome(r), name, "SKILL.md")).find((p) => fs.existsSync(p));
    if (!skillPath) continue; // configured-but-absent — silently skipped
    try {
      const fm = readFrontmatter(skillPath);
      out.push({ source: "library", name: fm.name, description: fm.description, path: skillPath });
    } catch (e) {
      console.warn(`amicode: skipping malformed library skill ${skillPath}: ${e}`);
    }
  }
  return out;
}

/** Stage the resolved (guarded) skill set as opencode-native skills for this
 *  session: copy each SKILL.md to `<stageRoot>/<name>/SKILL.md` so opencode's
 *  loader — pointed HERE via config `skills.paths` (an absolute dir) — registers
 *  exactly this set and no more. We must NOT point `skills.paths` at a library
 *  root: opencode scans it recursively for `**​/SKILL.md`, which would leak the
 *  ~50 process skills (the exact guard from spec §3). Folder name = frontmatter
 *  `name`, satisfying opencode's name-matches-folder rule; content is copied
 *  verbatim (opencode ignores the extra `agents:` field — verified 2026-07-04).
 *  Returns the stage root, or "" if nothing was staged (→ no `skills.paths`). */
export function stageOpencodeSkills(stageRoot: string, entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return "";
  let staged = 0;
  for (const e of entries) {
    try {
      const dir = path.join(stageRoot, e.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(e.path, path.join(dir, "SKILL.md"));
      staged++;
    } catch (err) {
      console.warn(`amicode: could not stage skill ${e.name} for opencode: ${err}`); // never dead-end (spec §9)
    }
  }
  return staged > 0 ? stageRoot : "";
}

/** Splice one merged index into the prompt — platform entries FIRST (spec §3),
 *  then package entries. Empty index → empty string (no section at all).
 *  The skills are registered as opencode-native skills (stageOpencodeSkills +
 *  config `skills.paths`), so the agent INVOKES them by name — it must not try to
 *  read a file path (observed 2026-07-04: the agent guessed `atoms` as a skill;
 *  now it IS one). The index adds the usage guidance opencode's auto-listing
 *  lacks (physics-reference framing + the §6 verification contract). */
export function buildSkillIndexSection(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return ""; // no section at all (spec §3)
  const platform = entries.filter((e) => e.source === "library");
  const pkg = entries.filter((e) => e.source === "package");
  const lines = [
    "## Skill index", // registered opencode skills (platform + package)
    "",
    "The following are registered as opencode **skills** for this session.",
    // Single line on purpose: the invoke-before-authoring instruction is asserted as one regex.
    "**Invoke a skill by its name to load its full reference BEFORE authoring any script on its platform or importing its package** —",
    "it carries construction patterns, integrator selection, and the verification",
    "contract your script must emit.",
    "",
    ...platform.map(
      (e) =>
        `- **${e.name}** (platform reference) — ${e.description}\n  - Use as physics reference — inline the constants; authored scripts stay self-contained (no \`include\` of demo-repo files).`,
    ),
    ...pkg.map((e) => `- **${e.name}** (package: ${e.package}) — ${e.description}`),
    "",
  ];
  return lines.join("\n");
}
