import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml"; // same parser as scores/loader.ts

// Dual-source skill index (spec-20260704-113005 §1/§3). Two skill TYPES:
//   - PACKAGE skills: co-located at packages/<P>.jl/skills/<name>/SKILL.md,
//     discovered ONLY for entitlement-allowlisted packages (gated).
//   - LIBRARY skills: cross-package refs in the in-repo library
//     (packages/extension/skills/, moved out of the retired amico-plugin repo),
//     discovered by SURFACE TAG (spec-20260713-003804): the library dir
//     is scanned, but ONLY skills whose frontmatter `surface:` tag is admitted
//     by the root AND (for the entitled tier) covered by the session's resolved
//     entitlements are staged. `internal`, untagged, and any other value MUST
//     NOT leak into Amicode; the tag IS the least-privilege guard, and the repo
//     boundary backs it (internal content lives only in the armonissima vault).
//     Three surface tiers (ADR-0003 as amended by spec §A1 / ADR-0011):
//     `public` = ships and loads for all; `entitled` = ships in the .vsix but
//     stages ONLY for sessions whose resolved entitlements include the skill's
//     `entitlement:` code (a STAGING gate, not a location — entitled skills
//     share the in-repo library with public ones); `internal` = private vault,
//     never ships.
// Content is read on demand by the agent — never baked into the prompt or the
// .vsix. Errors mirror the entitlements philosophy: skip + warn, never throw.
export interface SkillIndexEntry {
  source: "library" | "package" | "custom" | "workspace" | "project"; // platform | co-located | user-added | workspace .opencode/skills/ | research project skills/
  package?: string; // absent for library entries (spec §3)
  name: string;
  description: string;
  path: string; // absolute SKILL.md path
}

/** A typed library root (ADR-0003, amicode#242): the directory PLUS the `surface:`
 *  tags it admits. Three tiers (ADR-0003 as amended by spec §A1 / ADR-0011) —
 *  the dev's private plugin checkout admits {public, internal} (checkout presence
 *  IS the eligibility proof: internal SKILL.md content exists only in the private
 *  repo, so nobody stages skills they do not already possess); the in-repo
 *  library admits {public, entitled} — entitled entries additionally pass the
 *  entitlement staging gate in resolveLibrarySkills; the vendored public bundle
 *  admits {public} only, as defense in depth on top of the extract pipeline's
 *  guarantee. */
export interface LibraryRoot {
  path: string;
  surfaces: string[]; // admitted `surface:` tags
}
/** A bare string root keeps the pre-typing behavior: public-only. Settings
 *  overrides written before ADR-0003 are string arrays — they keep working. */
export type LibraryRootSpec = string | LibraryRoot;

function normalizeLibraryRoot(r: LibraryRootSpec): LibraryRoot {
  return typeof r === "string" ? { path: r, surfaces: ["public"] } : r;
}

/** Parse the raw `amicode.skillLibraryRoots` setting value into root specs
 *  (ADR-0003 back-compat). Bare strings pass through (public-only, the pre-ADR
 *  behavior); typed objects need a non-empty `path` and a non-empty `surfaces`
 *  string array. Malformed entries are dropped with a warning — the settings
 *  surface mirrors the resolver's skip+warn philosophy, never throws. */
export function parseLibraryRootSpecs(raw: unknown): LibraryRootSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryRootSpec[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    const e = entry as Partial<LibraryRoot> | null;
    const ok =
      e !== null &&
      typeof e === "object" &&
      typeof e.path === "string" &&
      e.path.trim() !== "" &&
      Array.isArray(e.surfaces) &&
      e.surfaces.length > 0 &&
      e.surfaces.every((s) => typeof s === "string");
    if (ok) out.push({ path: (e as LibraryRoot).path, surfaces: (e as LibraryRoot).surfaces });
    else console.warn(`amicode: dropping malformed skillLibraryRoots entry: ${JSON.stringify(entry)}`);
  }
  return out;
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return path.join(process.env.HOME ?? "", p.slice(2));
  return p;
}

/** Parse a SKILL.md's frontmatter; throw on anything malformed (caller skips).
 *  `surface` (spec-20260713-003804) is optional — a string tag
 *  (`public` | `entitled` | `internal`) or undefined when the skill is untagged.
 *  `entitlement` (spec §Amendment A1) is the code a session must hold for an
 *  entitled-surface skill to stage (see resolveLibrarySkills). It drives
 *  library-skill staging. */
function readFrontmatter(skillPath: string): {
  name: string;
  description: string;
  surface?: string;
  entitlement?: string;
} {
  const raw = fs.readFileSync(skillPath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("missing frontmatter");
  const fm = parseYaml(m[1]) as {
    name?: string;
    description?: string;
    surface?: string;
    entitlement?: string;
  };
  if (typeof fm.name !== "string" || typeof fm.description !== "string")
    throw new Error("frontmatter needs name + description");
  return {
    name: fm.name,
    description: fm.description,
    surface: typeof fm.surface === "string" ? fm.surface : undefined,
    entitlement: typeof fm.entitlement === "string" ? fm.entitlement : undefined,
  };
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

/** Library skills from the in-repo library, discovered by SURFACE
 *  TAG (spec-20260713-003804) under PER-ROOT eligibility (ADR-0003, amicode#242)
 *  plus the ENTITLED-TIER staging gate (spec §Amendment A1, ADR-0011).
 *  Each root is scanned, but ONLY skills whose frontmatter `surface:` tag is in
 *  that root's admitted `surfaces` are returned — the in-repo root admits
 *  {public, entitled}, the armonissima vault root admits {internal} only, so
 *  internal content can stage ONLY from a vault mount the user already syncs.
 *  `entitlements` (the session's resolved codes, from LocalEntitlementProvider —
 *  resolved at prep time for EVERY session type) gates the entitled tier:
 *  a `surface: entitled` skill stages IFF its `entitlement:` code is present
 *  AND well-formed; a missing/malformed code is skip + warn (never throw),
 *  a well-formed code the session lacks is a SILENT skip (an unentitled
 *  session is the normal case, not an error).
 *  Untagged and malformed skills are DROPPED from every root. Staging
 *  (stageOpencodeSkills) copies only THIS selected set to the per-session stage
 *  dir — `skills.paths` never points at a library root itself. First root
 *  holding a given `<name>/SKILL.md` wins.
 *
 *  The private tier is NOT otherwise a library concern: private-package skills
 *  live co-located in their package repos and are gated by resolvePackageSkills
 *  (entitlement-derived allowlist ∩ repo presence). */
export function resolveLibrarySkills(roots: LibraryRootSpec[], entitlements: string[] = []): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  const seen = new Set<string>(); // first-root-wins, keyed by dir name
  for (const r of roots) {
    const root = normalizeLibraryRoot(r);
    const rootPath = expandHome(root.path);
    let names: string[] = [];
    try {
      names = fs.readdirSync(rootPath);
    } catch {
      continue; // missing library root — silently skipped (session proceeds)
    }
    for (const name of names.sort()) {
      if (seen.has(name)) continue;
      const skillPath = path.join(rootPath, name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      let fm: { name: string; description: string; surface?: string; entitlement?: string };
      try {
        fm = readFrontmatter(skillPath);
      } catch (e) {
        console.warn(`amicode: skipping malformed library skill ${skillPath}: ${e}`);
        continue;
      }
      if (fm.surface === undefined) {
        console.warn(`amicode: dropping untagged library skill ${skillPath} (no surface: tag — default-deny)`);
        continue;
      }
      if (fm.surface === "entitled") {
        // The entitled-tier staging gate (spec §A1.3(a)). A malformed/missing
        // code is a frontmatter defect — the skill could never stage from ANY
        // root, so warn (mirrors the untagged default-deny). A well-formed code
        // the session lacks is the normal unentitled case — silently absent.
        const code = fm.entitlement;
        if (typeof code !== "string" || code.trim() === "") {
          console.warn(
            `amicode: dropping entitled library skill ${skillPath} (surface: entitled needs a non-empty entitlement: code)`,
          );
          continue;
        }
        if (!entitlements.includes(code)) continue;
      }
      if (!root.surfaces.includes(fm.surface)) continue; // THE GUARD, per-root
      seen.add(name); // this dir is the authoritative skill of that name (earlier root wins)
      out.push({ source: "library", name: fm.name, description: fm.description, path: skillPath });
    }
  }
  return out;
}

/** Stage the resolved (guarded) skill set as opencode-native skills for this
 *  session: copy each skill's WHOLE dir to `<stageRoot>/<name>/` so opencode's
 *  loader — pointed HERE via config `skills.paths` (an absolute dir) — registers
 *  exactly this set and no more. We must NOT point `skills.paths` at a library
 *  root: opencode scans it recursively for `**​/SKILL.md`, which would leak the
 *  ~50 process skills (the exact guard from spec §3). Folder name = frontmatter
 *  `name`, satisfying opencode's name-matches-folder rule; content is copied
 *  verbatim (opencode ignores the extra `agents:` field — verified 2026-07-04).
 *  Companions (tdd's craft docs, the physics references/ dirs) ride along:
 *  SKILL.md relative links must resolve inside the stage copy, and the source
 *  dir is already fully granted to the agent (skillGrants), so staging them
 *  exposes nothing new (amicode#393). Still ONLY the resolved set — one dir
 *  per entry, nothing else. Returns the stage root, or "" if nothing was
 *  staged (→ no `skills.paths`). */
export function stageOpencodeSkills(stageRoot: string, entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return "";
  let staged = 0;
  for (const e of entries) {
    try {
      const dir = path.join(stageRoot, e.name);
      fs.cpSync(path.dirname(e.path), dir, { recursive: true });
      staged++;
    } catch (err) {
      console.warn(`amicode: could not stage skill ${e.name} for opencode: ${err}`); // never dead-end (spec §9)
    }
  }
  return staged > 0 ? stageRoot : "";
}

/** Splice one merged index into the prompt — platform entries FIRST (spec §3),
 *  then custom, workspace, then package entries. Empty index → empty string
 *  (no section at all). Supports `overridesShipped` flag from mergeSkillEntries
 *  for labeling shadows. */
export function buildSkillIndexSection(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return ""; // no section at all (spec §3)
  const platform = entries.filter((e) => e.source === "library");
  const project = entries.filter((e) => e.source === "project");
  const custom = entries.filter((e) => e.source === "custom");
  const workspace = entries.filter((e) => e.source === "workspace");
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
    ...project.map((e) => {
      const label = (e as any).overridesShipped ? "(project, overrides platform)" : "(project)";
      return `- **${e.name}** ${label} — ${e.description}`;
    }),
    ...custom.map((e) => {
      const label = (e as any).overridesShipped ? "(custom, overrides platform)" : "(custom)";
      return `- **${e.name}** ${label} — ${e.description}`;
    }),
    ...workspace.map((e) => {
      const label = (e as any).overridesShipped ? "(workspace, overrides platform)" : "(workspace)";
      return `- **${e.name}** ${label} — ${e.description}`;
    }),
    ...pkg.map((e) => `- **${e.name}** (package: ${e.package}) — ${e.description}`),
    "",
  ];
  return lines.join("\n");
}
