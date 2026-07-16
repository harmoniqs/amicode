#!/usr/bin/env node
// Vendoring of the public skill subset, pinned by skills.lock.json.
//
// Downloads the amico-plugin `skills-public-vX` release asset (a PRIVATE repo,
// so the gh-CLI auth path — same as fetch_opencode.mjs; a plain fetch 404s on
// private assets), verifies its sha256, and extracts it into
// vendor/skills-public/. That dir ships in the vsix (.vscodeignore `!vendor/**`)
// and is resolved at runtime as a library root (opencode_config
// DEFAULT_LIBRARY_ROOTS), so a Marketplace user with no private amico-plugin
// checkout still gets the leak-guarded public skills, while a dev with the
// checkout keeps their live copy (first-root-wins).
//
// Importable module + CLI. Requires `gh` installed and authed for the repo (in
// CI: the GH_TOKEN the `package` step already exports must be able to read
// harmoniqs/amico-plugin releases).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest(root = PKG_ROOT) {
  const m = JSON.parse(readFileSync(join(root, "skills.lock.json"), "utf8"));
  if (typeof m.repo !== "string" || m.repo === "") throw new Error("skills.lock: repo required");
  if (typeof m.tag !== "string" || m.tag === "") throw new Error("skills.lock: tag required");
  if (typeof m.asset !== "string" || m.asset === "") throw new Error("skills.lock: asset required");
  if (!/^[0-9a-f]{64}$/.test(m.sha256 ?? "")) throw new Error("skills.lock: sha256 must be 64 hex chars");
  return m;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Private-release download via gh (plain fetch 404s on private assets). */
function ghDownload(repo, tag, asset) {
  const work = mkdtempSync(join(PKG_ROOT, ".ghdl-skills-"));
  try {
    execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", work], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return { file: join(work, asset), work };
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(
      `gh release download failed for ${repo}@${tag} ${asset}: ${e.message} — is \`gh\` installed and authed for ${repo}?`,
    );
  }
}

export function fetchSkills({ root = PKG_ROOT } = {}) {
  const m = loadManifest(root);
  const dest = join(root, "vendor", "skills-public");
  const { file, work } = ghDownload(m.repo, m.tag, m.asset);
  try {
    const got = sha256(readFileSync(file));
    if (got !== m.sha256) throw new Error(`sha256 mismatch for ${m.asset}: expected ${m.sha256}, got ${got}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["-xzf", file, "-C", dest], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const skillsDir = join(dest, "skills");
  if (!existsSync(skillsDir)) throw new Error(`extracted artifact missing skills/ dir at ${skillsDir}`);
  const manifest = JSON.parse(readFileSync(join(dest, "MANIFEST.json"), "utf8"));
  console.log(`fetch:skills — ${m.tag} (${manifest.skill_count} public, ${manifest.held_count} held) -> ${dest}`);
  return { dest, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    fetchSkills();
  } catch (e) {
    console.error(`fetch:skills failed: ${e.message}`);
    process.exit(1);
  }
}
