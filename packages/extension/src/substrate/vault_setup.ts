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

export const PUBLIC_VAULT_DIR = "vault-public";
export const PUBLIC_VAULT_REPO = "https://github.com/harmoniqs/vault-public.git";
export const PUBLIC_VAULT_KIND = "public";

function defaultVaultsRoot(): string {
  return path.join(os.homedir(), ".amico", "vaults");
}
function defaultMountsTomlPath(): string {
  return path.join(os.homedir(), ".amico", "mounts.toml");
}
function armoniaDataRoot(): string {
  return path.join(os.homedir(), "armonia", "data");
}

export interface CreatedVault {
  path: string;
  name: string;
  gitInit: boolean;
}

export interface VaultEcosystemResult {
  personal?: CreatedVault;
  publicCloned: boolean;
  publicPlaceholder: boolean;
  mountsWritten: boolean;
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

/** Ensure ~/armonia/data/{env,problems,runs,vaults} and ~/.amico symlinks. Never throws. */
export function ensureArmoniaDataDirs(): void {
  try {
    const dataRoot = armoniaDataRoot();
    for (const sub of ["env", "problems", "runs", "vaults"]) {
      try {
        fs.mkdirSync(path.join(dataRoot, sub), { recursive: true });
      } catch {}
    }
    // Wire ~/.amico/<name> -> ~/armonia/data/<target> when safe.
    const links: Array<[string, string]> = [
      ["julia", "env"],
      ["problems", "problems"],
      ["runs", "runs"],
      ["vaults", "vaults"],
    ];
    const amico = path.join(os.homedir(), ".amico");
    try {
      fs.mkdirSync(amico, { recursive: true });
    } catch {}
    for (const [srcName, targetName] of links) {
      const src = path.join(amico, srcName);
      const dest = path.join(dataRoot, targetName);
      try {
        if (fs.lstatSync(src).isSymbolicLink()) continue;
      } catch {}
      try {
        if (fs.existsSync(src)) {
          // Real dir with content → migration case, don't clobber.
          const entries = fs.readdirSync(src);
          if (entries.length > 0) continue;
          fs.rmdirSync(src);
        }
        fs.symlinkSync(dest, src);
      } catch {}
    }
  } catch {}
}

/** Ensure the public vault (vault-public, kind=public, ro). Never throws. */
export function ensurePublicVault(opts: {
  vaultsRoot?: string;
  repo?: string;
  timeoutMs?: number;
} = {}): { cloned: boolean; placeholder: boolean } {
  const vaultsRoot = opts.vaultsRoot ?? defaultVaultsRoot();
  const repo = opts.repo ?? PUBLIC_VAULT_REPO;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const dir = path.join(vaultsRoot, PUBLIC_VAULT_DIR);
  const marker = path.join(dir, ".amico-vault.toml");

  // Already present (any kind) → no-op.
  try {
    if (fs.existsSync(marker)) return { cloned: false, placeholder: false };
  } catch {}
  if (fs.existsSync(dir)) {
    // Dir exists without marker → seed marker as public.
    try {
      fs.writeFileSync(marker, `kind = "${PUBLIC_VAULT_KIND}"\nname = "${PUBLIC_VAULT_DIR}"\n`);
      return { cloned: false, placeholder: true };
    } catch {
      return { cloned: false, placeholder: false };
    }
  }

  // Try shallow clone.
  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", repo, dir], {
      stdio: "ignore",
      timeout: timeoutMs,
    });
    // Ensure marker is public (repo should already carry it).
    try {
      const text = fs.readFileSync(marker, "utf8");
      if (!text.includes(`kind = "${PUBLIC_VAULT_KIND}"`)) {
        fs.writeFileSync(marker, `kind = "${PUBLIC_VAULT_KIND}"\nname = "${PUBLIC_VAULT_DIR}"\n`);
      }
    } catch {
      try {
        fs.writeFileSync(marker, `kind = "${PUBLIC_VAULT_KIND}"\nname = "${PUBLIC_VAULT_DIR}"\n`);
      } catch {}
    }
    return { cloned: true, placeholder: false };
  } catch {}

  // Offline / no-git / timeout → placeholder.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `kind = "${PUBLIC_VAULT_KIND}"\nname = "${PUBLIC_VAULT_DIR}"\n`);
    try {
      fs.writeFileSync(path.join(dir, "README.md"), "# vault-public (offline placeholder)\n\nCloned on next online activate.\n");
    } catch {}
    return { cloned: false, placeholder: true };
  } catch {
    return { cloned: false, placeholder: false };
  }
}

/** Ensure ~/.amico/mounts.toml exists with personal + public precedence. Absent-only. */
export function ensureMountsToml(opts: {
  mountsTomlPath?: string;
  vaultsRoot?: string;
} = {}): boolean {
  const mountsTomlPath = opts.mountsTomlPath ?? defaultMountsTomlPath();
  const vaultsRoot = opts.vaultsRoot ?? defaultVaultsRoot();
  try {
    if (fs.existsSync(mountsTomlPath)) return false;
  } catch {}
  // Resolve personal name from actual dirs after ensure steps.
  let personalId: string | undefined;
  try {
    const entries = fs.readdirSync(vaultsRoot);
    for (const base of entries) {
      const marker = path.join(vaultsRoot, base, ".amico-vault.toml");
      try {
        const text = fs.readFileSync(marker, "utf8");
        if (text.includes('kind = "personal"')) {
          const m = text.match(/name\s*=\s*"([^"]+)"/);
          personalId = m ? m[1] : base;
          break;
        }
      } catch {}
    }
  } catch {}

  const lines: string[] = [];
  if (personalId) {
    lines.push("[[mount]]");
    lines.push(`id = "${personalId}"`);
    lines.push(`kind = "personal"`);
    lines.push(`writable = true`);
    lines.push("");
  }
  // Public entry — always emitted if vault-public dir exists (even placeholder).
  const publicDir = path.join(vaultsRoot, PUBLIC_VAULT_DIR);
  let hasPublic = false;
  try {
    hasPublic = fs.existsSync(path.join(publicDir, ".amico-vault.toml"));
  } catch {}
  if (hasPublic) {
    lines.push("[[mount]]");
    lines.push(`id = "${PUBLIC_VAULT_DIR}"`);
    lines.push(`kind = "${PUBLIC_VAULT_KIND}"`);
    lines.push(`writable = false`);
    lines.push("");
  }
  if (lines.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(mountsTomlPath), { recursive: true });
    fs.writeFileSync(mountsTomlPath, lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

/** Full first-run ecosystem: data dirs + personal + public + mounts.toml. Never throws. */
export function ensureVaultEcosystem(opts: {
  vaultsRoot?: string;
  mountsTomlPath?: string;
  publicRepo?: string;
  hint?: string;
} = {}): VaultEcosystemResult {
  const vaultsRoot = opts.vaultsRoot ?? defaultVaultsRoot();
  const mountsTomlPath = opts.mountsTomlPath ?? defaultMountsTomlPath();
  const result: VaultEcosystemResult = { publicCloned: false, publicPlaceholder: false, mountsWritten: false };

  ensureArmoniaDataDirs();

  // Personal — silent auto-provision if none resolves.
  let hasPersonal = false;
  try {
    const entries = fs.readdirSync(vaultsRoot);
    for (const base of entries) {
      try {
        const text = fs.readFileSync(path.join(vaultsRoot, base, ".amico-vault.toml"), "utf8");
        if (text.includes('kind = "personal"')) { hasPersonal = true; break; }
      } catch {}
    }
  } catch {}
  if (!hasPersonal) {
    try {
      const created = createLocalPersonalVault(vaultsRoot, suggestVaultName(opts.hint));
      result.personal = created;
    } catch {}
  }

  const pub = ensurePublicVault({ vaultsRoot, repo: opts.publicRepo });
  result.publicCloned = pub.cloned;
  result.publicPlaceholder = pub.placeholder;

  result.mountsWritten = ensureMountsToml({ mountsTomlPath, vaultsRoot });
  return result;
}
