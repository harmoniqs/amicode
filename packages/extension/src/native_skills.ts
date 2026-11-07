/** Native user-skill staging (#1949 §1) — skills reach EVERY engine.
 *
 *  The extension already registers its resolved skill set per session via the
 *  generated config's `skills.paths` (stageOpencodeSkills). A plain `opencode`
 *  started from a terminal never sees that config, so it loaded the staged
 *  agent cards (~/.config/opencode/agents/, mode_cards.ts) but NO amicode
 *  skills — the develop card's first action ("invoke director-core, then
 *  develop") failed with "Skill not found".
 *
 *  Engine source of record (upstream base 3104c142…, packages/opencode/src/
 *  skill/index.ts `discoverSkills`): besides ~/.claude/skills and
 *  ~/.agents/skills, the engine globs `{skill,skills}/**\/SKILL.md` under every
 *  `config.directories()` entry — which always includes Global.Path.config
 *  (`$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`). So the native
 *  user dir is `<opencode config dir>/skills/<name>/SKILL.md`.
 *
 *  Same resolution as the hub's machine-stable set (resolveMachineSkillEntries:
 *  library roots by `surface:` admission + the entitled-tier gate + the
 *  entitlement-allowlisted package skills) — surfaces and entitlements are
 *  respected exactly as the existing staging does. Ownership discipline (the
 *  dir is SHARED with the user): the extension manages ONLY dir names its
 *  receipt lists — a pre-existing dir it does not own is never overwritten
 *  (reported as skippedUserOwned), and only owned dirs that left the set are
 *  removed. Never throws past the caller's activation catch for a single
 *  skill (skip + record, never dead-end). */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { opencodeConfigDir } from "./opencode_xdg";
import { resolveMachineSkillEntries } from "./opencode_config";
import {
  NATIVE_SKILLS_RECEIPT_NAME,
  readNativeSkillsOwned,
  type LibraryRootSpec,
} from "./scores/package_skills";

export { NATIVE_SKILLS_RECEIPT_NAME, readNativeSkillsOwned };

/** The engine's native user skill dir: <opencode config dir>/skills. */
export function nativeUserSkillsDir(): string {
  return path.join(opencodeConfigDir(), "skills");
}

export interface NativeSkillStageOptions {
  /** Destination dir; default nativeUserSkillsDir(). */
  destDir?: string;
  scoresRoot?: string;
  entitlementsDir?: string;
  skillRoots?: string[];
  skillLibraryRoots?: LibraryRootSpec[];
  /** Clock injection (receipt timestamp). */
  now?: () => string;
}

export interface NativeSkillStageResult {
  dir: string;
  /** Skill dir names staged (and now owned), sorted. */
  staged: string[];
  /** Previously-owned dirs removed because they left the resolved set. */
  removed: string[];
  /** Resolved names NOT staged because a user-authored dir already holds the name. */
  skippedUserOwned: string[];
  receiptPath: string;
}

export function stageNativeUserSkills(opts: NativeSkillStageOptions = {}): NativeSkillStageResult {
  const dir = opts.destDir ?? nativeUserSkillsDir();
  const nowIso = opts.now ?? (() => new Date().toISOString());
  const { entries } = resolveMachineSkillEntries(opts);
  fs.mkdirSync(dir, { recursive: true });

  const previouslyOwned = new Set(readNativeSkillsOwned(dir));
  const staged: string[] = [];
  const skippedUserOwned: string[] = [];
  const records: Array<{ name: string; revision: number; sha256: string; source: string }> = [];
  for (const e of entries) {
    const target = path.join(dir, e.name);
    if (fs.existsSync(target) && !previouslyOwned.has(e.name)) {
      skippedUserOwned.push(e.name); // the user's dir — never overwritten
      continue;
    }
    try {
      // replace, not merge: a file dropped upstream must not linger in our copy
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.dirname(e.path), target, { recursive: true });
      staged.push(e.name);
      records.push({
        name: e.name,
        revision: e.revision ?? 0,
        sha256: "sha256:" + createHash("sha256").update(fs.readFileSync(e.path)).digest("hex"),
        source: e.path,
      });
    } catch (err) {
      console.warn(`amicode: could not stage native skill ${e.name}: ${err}`); // never dead-end
    }
  }

  // Only dirs WE owned and that left the resolved set are removed (e.g. an
  // entitlement revoked) — never a dir the receipt does not list.
  const stagedSet = new Set(staged);
  const removed: string[] = [];
  for (const name of previouslyOwned) {
    if (stagedSet.has(name)) continue;
    if (skippedUserOwned.includes(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      console.warn(`amicode: could not remove stale native skill ${name}: ${err}`);
    }
  }
  staged.sort();
  removed.sort();
  skippedUserOwned.sort();

  const receiptPath = path.join(dir, NATIVE_SKILLS_RECEIPT_NAME);
  fs.writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        receipt_version: 1,
        staged_at: nowIso(),
        dir,
        owned: staged,
        skills: records.sort((a, b) => a.name.localeCompare(b.name)),
        skipped_user_owned: skippedUserOwned,
      },
      null,
      2,
    ) + "\n",
  );
  return { dir, staged, removed, skippedUserOwned, receiptPath };
}
