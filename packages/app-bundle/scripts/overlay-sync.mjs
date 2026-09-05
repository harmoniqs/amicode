#!/usr/bin/env node
// Overlay ↔ fork sync check and apply.
//
// The fork (~/harmoniqs/opencode or AMICODE_OPENCODE_SRC) is the source of
// truth for all app source files. The overlay (packages/app-bundle/overlay/)
// is a tracking copy. This script detects and fixes drift between them.
//
//   node scripts/overlay-sync.mjs --check   exit 0 if in sync, 1 if drifted
//   node scripts/overlay-sync.mjs --apply   copy fork → overlay + update hashes
//
// Resolves the fork path in order:
//   1. AMICODE_OPENCODE_SRC env var
//   2. ../opencode sibling (relative to repo root)
//   3. ~/harmoniqs/opencode
// Skips with exit 0 if no fork clone is found.

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
import { dirname, join, relative } from "node:path"

const PKG_ROOT = join(import.meta.dirname, "..")
const REPO_ROOT = join(PKG_ROOT, "..", "..")
const OVERLAY_DIR = join(PKG_ROOT, "overlay")
const MANIFEST_PATH = join(PKG_ROOT, "manifest.json")

// ── Resolve fork path ───────────────────────────────────────────────────────

function resolveForkDir() {
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

function check(forkDir) {
  const overlayFiles = walkDir(OVERLAY_DIR)
  const drifted = []
  const missingInFork = []

  for (const rel of overlayFiles) {
    const overlayPath = join(OVERLAY_DIR, rel)
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

// ── Apply mode ──────────────────────────────────────────────────────────────

function apply(forkDir) {
  const { drifted, missingInFork } = check(forkDir)

  if (drifted.length === 0 && missingInFork.length === 0) {
    console.log("[overlay-sync] already in sync — nothing to do")
    return 0
  }

  // Read manifest
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
  let updated = 0

  for (const { rel } of drifted) {
    const forkPath = join(forkDir, rel)
    const overlayPath = join(OVERLAY_DIR, rel)

    // Ensure parent directory exists
    mkdirSync(dirname(overlayPath), { recursive: true })

    // Copy fork → overlay
    copyFileSync(forkPath, overlayPath)

    // Update manifest hash
    const newHash = sha256(overlayPath)
    if (manifest.files && manifest.files[rel] !== undefined) {
      manifest.files[rel] = newHash
    }

    console.log(`  updated: ${rel}`)
    updated++
  }

  for (const rel of missingInFork) {
    console.log(`  warning: ${rel} exists in overlay but not in fork (class A amicode-only?)`)
  }

  if (updated > 0) {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n")
    console.log(`[overlay-sync] applied ${updated} file(s), manifest.json updated`)
  }

  return 0
}

// ── Main ────────────────────────────────────────────────────────────────────

const mode = process.argv.includes("--apply") ? "apply" : "check"

const forkDir = resolveForkDir()
if (!forkDir) {
  console.log("[overlay-sync] SKIP: no fork clone found (set AMICODE_OPENCODE_SRC)")
  process.exit(0)
}

console.log(`[overlay-sync] fork: ${forkDir}`)

if (mode === "apply") {
  process.exit(apply(forkDir))
} else {
  const { drifted, missingInFork } = check(forkDir)

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
    process.exit(1)
  }

  console.log(`[overlay-sync] PASS: all ${walkDir(OVERLAY_DIR).length} overlay files match the fork`)
  process.exit(0)
}
