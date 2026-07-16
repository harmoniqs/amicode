// First-run LOCAL personal-vault setup (spec: #13, dotfolder-style).
//
// Creates a local personal vault — a `~/.amico/vaults/<name>/` dir with a
// `.amico-vault.toml` marker (kind=personal) and a local `git init`, NO remote.
// It deliberately does NOT seed the `amicode/` memory substrate: the distiller
// (scripts/distill_batch.mjs) already `mkdir`s that skeleton on first run, so
// seeding here would duplicate it. The mount then resolves via
// resolveMountStack() like any other vault.
//
// v1 is personal-only + local; the synced tiers (team/public, e.g. armonissima)
// and a broader first-run "workspace setup" (Julia env, providers) are intended
// follow-ups — this is the first step of that setup, framed as a dotfolder init.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Fold a proposed name into a safe vault dir / mount name (lowercase kebab). */
export function sanitizeVaultName(raw: string): string {
  const s = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return s || "personal";
}

/** Suggested default name. Prefer an explicit hint (e.g. the onboarding profile
 *  name — a future wiring), else the OS username, else "personal". */
export function suggestVaultName(hint?: string): string {
  const base = (hint && hint.trim()) || safeUsername();
  return sanitizeVaultName(base);
}

function safeUsername(): string {
  try {
    return os.userInfo().username || "personal";
  } catch {
    return "personal";
  }
}

/**
 * Whether to AUTO-offer vault setup (the first-run notification). Fires ONLY for a
 * returning user — a profile already exists on this machine but no personal vault
 * resolves (e.g. they set up elsewhere / changed machines). Two cases deliberately
 * do NOT notify: a resolved vault (nothing to do), and a genuine first-timer with no
 * profile (the onboarding WIZARD walks them through vault creation, not this popup).
 * The `amicode.setupVault` command bypasses this — it's an explicit user action.
 */
export function shouldOfferVaultSetup(o: {
  hasPersonalVault: boolean;
  hasProfile: boolean;
  dismissed: boolean;
}): boolean {
  return !o.hasPersonalVault && o.hasProfile && !o.dismissed;
}

export interface CreatedVault {
  path: string;
  name: string;
  gitInit: boolean;
}

/**
 * Create a local personal vault. Refuses to clobber an existing directory.
 * `git init` is best-effort (the vault is fully functional without git).
 */
export function createLocalPersonalVault(
  vaultsRoot: string,
  rawName: string,
  opts: { gitInit?: boolean } = {},
): CreatedVault {
  const name = sanitizeVaultName(rawName);
  const dir = path.join(vaultsRoot, name);
  if (fs.existsSync(dir)) throw new Error(`a vault already exists at ${dir}`);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".amico-vault.toml"), `kind = "personal"\nname = "${name}"\n`);

  let gitInit = false;
  if (opts.gitInit !== false) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      gitInit = true;
    } catch {
      // git is optional — the vault resolves and works without a repo.
    }
  }
  return { path: dir, name, gitInit };
}
