#!/usr/bin/env node
// Overlay ↔ fork sync check and apply.
//
// The fork (~/harmoniqs/opencode or AMICODE_OPENCODE_SRC) is the source of
// truth for the app source files amicode has NOT fixed. The overlay
// (packages/app-bundle/overlay/) is a tracking copy. This script detects and
// fixes drift between them.
//
//   node scripts/overlay-sync.mjs --check   exit 0 if in sync, 1 if drifted
//   node scripts/overlay-sync.mjs --apply   copy fork → overlay + update hashes
//
// Options:
//   --source <dir>        fork checkout to read from (default: resolved fork)
//   --target <dir>        overlay tree to read/apply (default:
//                         packages/app-bundle/overlay) — the tests aim this at
//                         a tmpdir so no run mutates committed overlay state
//   --manifest <path>     manifest to update (default: <target>/../manifest.json)
//   --source-branch <b>   expected fork branch (default: local/amicode)
//
// SAFETY (#842) — the sync must never silently clobber committed state:
//   * --check NEVER writes.
//   * --apply refuses when the source checkout is not on the expected branch
//     (default local/amicode) or has uncommitted changes — named remedy
//     (mirrors #992's pre-flight). Set AMICODE_OVERLAY_SYNC_OVERRIDE=<reason>
//     to proceed with the waiver recorded; an empty reason refuses.
//   * --apply refuses, writing nothing, when the copy would REVERT an
//     amicode-side known fix (#964/#929/#832) — the known-fixes fixture list
//     is the shared module scripts/known_fixes.mjs. This is why the sync is
//     safe to run: the fork is authoritative for unfixed files only.
//
// Resolves the fork path in order:
//   1. --source
//   2. AMICODE_OPENCODE_SRC env var
//   3. ../opencode sibling (relative to repo root)
//   4. ~/harmoniqs/opencode
// Skips with exit 0 if no fork clone is found.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { checkKnownFixes, evaluateKnownFixes, localeDicts } from "./known_fixes.mjs"

const PKG_ROOT = join(import.meta.dirname, "..")
const REPO_ROOT = join(PKG_ROOT, "..", "..")
const DEFAULT_OVERLAY_DIR = join(PKG_ROOT, "overlay")
const DEFAULT_SOURCE_BRANCH = "local/amicode"

// ── Resolve fork path ───────────────────────────────────────────────────────

function resolveForkDir(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidates = [
    process.env.AMICODE_OPENCODE_SRC,
    join(REPO_ROOT, "..", "opencode"),
    join(homedir(), "harmoniqs", "opencode"),
  ].filter(Boolean)

  for (const dir of candidates) {
    if (dir && existsSync(join(dir, ".git"))) return dir
  }
  return null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256(filepath) {
  const st = lstatSync(filepath)
  if (st.isSymbolicLink()) {
    return createHash("sha256").update(readlinkSync(filepath)).digest("hex")
  }
  return createHash("sha256").update(readFileSync(filepath)).digest("hex")
}

function walkDir(dir) {
  const results = []
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, entry.toString())
    const st = lstatSync(full)
    if (st.isFile() || st.isSymbolicLink()) {
      results.push(entry.toString())
    }
  }
  return results
}

// ── Check mode ──────────────────────────────────────────────────────────────

function check(forkDir, overlayDir) {
  const overlayFiles = walkDir(overlayDir)
  const drifted = []
  const missingInFork = []

  for (const rel of overlayFiles) {
    const overlayPath = join(overlayDir, rel)
    const forkPath = join(forkDir, rel)

    if (!existsSync(forkPath)) {
      missingInFork.push(rel)
      continue
    }

    const overlayHash = sha256(overlayPath)
    const forkHash = sha256(forkPath)
    if (overlayHash !== forkHash) {
      drifted.push({ rel, overlayHash, forkHash })
    }
  }

  return { drifted, missingInFork }
}

// ── Source-branch guard (#842, mirrors #992) ────────────────────────────────
// Pure: the script gathers git's observations (observeSource), the DECISION
// lives here so the tests can drive every branch. Returns {ok:true, recorded}
// on proceed, or {ok:false, reasons:[named remedy,…]} on refusal. A valid
// override (a non-empty AMICODE_OVERLAY_SYNC_OVERRIDE reason) waives the
// branch/dirty refusal but is RECORDED; an empty reason refuses.
export function evaluateSourceGuard({ isGitRepo, branch, dirtyEntries, expectedBranch, overrideReason }) {
  const reasons = []
  const hasOverrideFlag = overrideReason !== undefined
  const validOverride = hasOverrideFlag && String(overrideReason).trim() !== ""

  if (!validOverride) {
    if (!isGitRepo) {
      reasons.push(
        `REFUSED: the source checkout is not a git checkout, so its branch and cleanliness cannot be ` +
          `verified — a sync from an unverifiable source can clobber committed overlay state (the #842 class). ` +
          `REMEDY: point --source / AMICODE_OPENCODE_SRC at the fork clone (a git repo on ${expectedBranch}), ` +
          `or set AMICODE_OVERLAY_SYNC_OVERRIDE=<reason> to proceed with the waiver recorded.`,
      )
    } else {
      if (branch !== expectedBranch) {
        reasons.push(
          `REFUSED: the source checkout is on branch '${branch || "(detached HEAD)"}', not the expected ` +
            `'${expectedBranch}'. A sync from an arbitrary branch copies arbitrary state over the overlay ` +
            `(the #842 class). REMEDY: cd the fork and 'git checkout ${expectedBranch}' (or pass ` +
            `--source-branch <b> for a deliberate mirror branch), then re-run ` +
            `(or set AMICODE_OVERLAY_SYNC_OVERRIDE=<reason> to proceed with the waiver recorded).`,
        )
      }
      if (dirtyEntries.length > 0) {
        reasons.push(
          `REFUSED: the source checkout is dirty (${dirtyEntries.length} entr${dirtyEntries.length === 1 ? "y" : "ies"}: ` +
            `${dirtyEntries.slice(0, 5).map((e) => e.trim()).join("; ")}${dirtyEntries.length > 5 ? "; …" : ""}) — ` +
            `uncommitted source state is not recorded anywhere the overlay can trace to (the #842 class). ` +
            `REMEDY: commit or stash the fork changes first ` +
            `(or set AMICODE_OVERLAY_SYNC_OVERRIDE=<reason> to proceed with the waiver recorded).`,
        )
      }
    }
  }
  if (hasOverrideFlag && !validOverride) {
    reasons.push(
      `REFUSED: AMICODE_OVERLAY_SYNC_OVERRIDE is set but its reason is empty — overrides without a stated ` +
        `reason are silent clobbers, exactly what #842 exists to prevent. ` +
        `REMEDY: set AMICODE_OVERLAY_SYNC_OVERRIDE to a non-empty reason.`,
    )
  }
  if (reasons.length > 0) return { ok: false, reasons }

  const recorded = []
  if (validOverride) {
    recorded.push(
      `OVERRIDE RECORDED: AMICODE_OVERLAY_SYNC_OVERRIDE="${String(overrideReason).trim()}" — source guard waived`,
    )
  }
  return { ok: true, recorded }
}

function observeSource(dir) {
  if (!existsSync(join(dir, ".git"))) return { isGitRepo: false, branch: null, dirtyEntries: [] }
  const branch = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim()
  const dirtyEntries = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
  return { isGitRepo: true, branch, dirtyEntries }
}

// ── Apply mode ──────────────────────────────────────────────────────────────

function apply(forkDir, targetDir, manifestPath) {
  const { drifted, missingInFork } = check(forkDir, targetDir)

  if (drifted.length === 0 && missingInFork.length === 0) {
    console.log("[overlay-sync] already in sync — nothing to do")
    return 0
  }

  // 1. The known-fixes rule, checked against the POST-APPLY tree BEFORE any
  //    write. If the fork's copy of a known-fixed file would revert the fix,
  //    refuse and write nothing.
  const appliedRels = new Set(drifted.map((d) => d.rel))
  const APP_SRC_PREFIX = join("packages", "app", "src")
  const appSrc = join(targetDir, APP_SRC_PREFIX)
  const readPost = (rel) => {
    const overlayRel = join(APP_SRC_PREFIX, rel)
    const p = appliedRels.has(overlayRel) ? join(forkDir, overlayRel) : join(targetDir, overlayRel)
    try {
      return readFileSync(p, "utf8")
    } catch {
      return null
    }
  }
  const listLocales = () => {
    try {
      return localeDicts(appSrc)
    } catch {
      return []
    }
  }
  const regressions = evaluateKnownFixes(readPost, listLocales, appSrc)
  if (regressions.length > 0) {
    console.error(
      `[overlay-sync] REFUSED: applying this sync would revert ${regressions.length} known amicode-side fix(es) — nothing written:`,
    )
    for (const r of regressions) console.error(`[overlay-sync]   ${r}`)
    console.error(
      `[overlay-sync] the fork is authoritative for unfixed files only; put the fix on the fork ` +
        `(branch ${DEFAULT_SOURCE_BRANCH}) so the next sync brings it, not the regression.`,
    )
    return 1
  }

  // 2. Read the manifest (optional — a tmp tree may not carry one).
  let manifest = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch {
      console.error(`[overlay-sync] WARN: manifest at ${manifestPath} is not valid JSON — copying without hash bookkeeping`)
      manifest = null
    }
  } else {
    console.log(`[overlay-sync] note: no manifest at ${manifestPath} — copying without hash bookkeeping`)
  }

  // 3. Copy fork → overlay.
  let updated = 0
  for (const { rel } of drifted) {
    const forkPath = join(forkDir, rel)
    const targetPath = join(targetDir, rel)

    mkdirSync(dirname(targetPath), { recursive: true })
    copyFileSync(forkPath, targetPath)

    if (manifest?.files && manifest.files[rel] !== undefined) {
      manifest.files[rel] = sha256(targetPath)
    }

    console.log(`  updated: ${rel}`)
    updated++
  }

  for (const rel of missingInFork) {
    console.log(`  warning: ${rel} exists in overlay but not in fork (class A amicode-only?)`)
  }

  if (manifest && updated > 0) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    console.log(`[overlay-sync] applied ${updated} file(s), manifest.json updated`)
  } else if (updated > 0) {
    console.log(`[overlay-sync] applied ${updated} file(s)`)
  }

  return 0
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    mode: argv.includes("--apply") ? "apply" : "check",
    source: flag("source"),
    target: flag("target") ?? DEFAULT_OVERLAY_DIR,
    manifest: flag("manifest") ?? null,
    sourceBranch: flag("source-branch") ?? DEFAULT_SOURCE_BRANCH,
  }
}

function main(argv) {
  const opts = parseArgs(argv)
  const targetDir = opts.target
  const manifestPath = opts.manifest ?? join(dirname(targetDir), "manifest.json")

  const forkDir = resolveForkDir(opts.source)
  if (!forkDir) {
    console.log("[overlay-sync] SKIP: no fork clone found (set AMICODE_OPENCODE_SRC or --source)")
    return 0
  }

  console.log(`[overlay-sync] fork: ${forkDir}`)
  console.log(`[overlay-sync] target: ${targetDir}`)

  if (opts.mode === "apply") {
    const overrideReason = process.env.AMICODE_OVERLAY_SYNC_OVERRIDE
    const guard = evaluateSourceGuard({
      ...observeSource(forkDir),
      expectedBranch: opts.sourceBranch,
      overrideReason,
    })
    if (!guard.ok) {
      console.error("[overlay-sync] source guard refused the apply:")
      for (const r of guard.reasons) console.error(`[overlay-sync]   ${r}`)
      return 1
    }
    for (const r of guard.recorded) console.log(`[overlay-sync] ${r}`)
    return apply(forkDir, targetDir, manifestPath)
  }

  // ── check (never writes) ──
  const { drifted, missingInFork } = check(forkDir, targetDir)

  let regressions = []
  const appSrc = join(targetDir, "packages", "app", "src")
  if (existsSync(appSrc)) {
    regressions = checkKnownFixes(appSrc)
    if (regressions.length > 0) {
      console.log(`[overlay-sync] ${regressions.length} known amicode-side fix(es) currently MISSING from the target:`)
      for (const r of regressions) console.log(`  ${r}`)
    }
  }

  if (missingInFork.length > 0) {
    console.log(`[overlay-sync] ${missingInFork.length} file(s) in overlay but not in fork:`)
    for (const rel of missingInFork.slice(0, 5)) {
      console.log(`  missing: ${rel}`)
    }
    if (missingInFork.length > 5) console.log(`  ... and ${missingInFork.length - 5} more`)
  }

  if (drifted.length > 0) {
    console.log(`[overlay-sync] DRIFT: ${drifted.length} file(s) differ between overlay and fork:`)
    for (const { rel } of drifted) {
      console.log(`  ${rel}`)
    }
    console.log(`\nRun: pnpm --filter @amicode/app-bundle sync:apply`)
  }

  if (drifted.length > 0 || regressions.length > 0) return 1

  console.log(`[overlay-sync] PASS: all ${walkDir(targetDir).length} overlay files match the fork`)
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  process.exit(main(process.argv.slice(2)))
}
