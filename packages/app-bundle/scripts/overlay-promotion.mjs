#!/usr/bin/env node
// Generate or verify the complete tracked overlay for one immutable fork
// revision. Rebuilds call --check; only an explicit promotion calls --apply.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

const PKG_ROOT = join(import.meta.dirname, "..")
const REPO_ROOT = join(PKG_ROOT, "..", "..")
const DEFAULT_TARGET = join(PKG_ROOT, "overlay")
const DEFAULT_MANIFEST = join(PKG_ROOT, "manifest.json")
const DEFAULT_SOURCE_BRANCH = "local/amicode"
const OVERLAY_PATHS = ["packages/app", "packages/ui", "packages/session-ui", "packages/schema", "packages/core", "packages/sdk"]

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const flags = (name) => args.flatMap((value, index) => value === `--${name}` && args[index + 1] ? [args[index + 1]] : [])

const fail = (message) => {
  console.error(`[overlay-promotion] FAIL: ${message}`)
  return 1
}

const hash = (value) => createHash("sha256").update(value).digest("hex")

function git(source, gitArgs, encoding = "utf8") {
  return execFileSync("git", ["-C", source, ...gitArgs], { encoding, maxBuffer: 1 << 28 })
}

function gitText(source, gitArgs) {
  return String(git(source, gitArgs)).trim()
}

function resolve(source, revision) {
  return gitText(source, ["rev-parse", `${revision}^{commit}`])
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir, { recursive: true })) {
    const rel = entry.toString()
    const stat = lstatSync(join(dir, rel))
    if (stat.isFile() || stat.isSymbolicLink()) files.push(rel)
  }
  return files.sort()
}

function fileHash(file) {
  const stat = lstatSync(file)
  return stat.isSymbolicLink() ? hash(readlinkSync(file)) : hash(readFileSync(file))
}

function sourceGuard(source, expectedBranch, revision) {
  if (!existsSync(join(source, ".git"))) return "the source is not a git checkout"
  const branch = gitText(source, ["branch", "--show-current"])
  if (branch !== expectedBranch) return `the source is on '${branch || "(detached HEAD)"}', not '${expectedBranch}'`
  if (gitText(source, ["status", "--porcelain"])) return "the source checkout is dirty"
  if (resolve(source, "HEAD") !== revision) return `--revision ${revision.slice(0, 12)} is not the checked-out source HEAD`
  return null
}

function changedPaths(source, base, revision) {
  const files = new Map()
  const deletions = new Set()
  const output = gitText(source, ["diff", "--name-status", base, revision, "--", ...OVERLAY_PATHS])
  if (!output) return { files, deletions }

  for (const line of output.split("\n")) {
    const fields = line.split("\t")
    const status = fields[0]
    if (status.startsWith("D")) {
      deletions.add(fields[1])
      continue
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R")) deletions.add(fields[1])
      files.set(fields[2], fileAtRevision(source, revision, fields[2]))
      continue
    }
    files.set(fields[1], fileAtRevision(source, revision, fields[1]))
  }
  return { files, deletions }
}

function fileAtRevision(source, revision, rel) {
  const mode = gitText(source, ["ls-tree", revision, "--", rel]).split(/\s+/)[0]
  return { bytes: git(source, ["show", `${revision}:${rel}`], null), symlink: mode === "120000" }
}

function fileAtAmicodeRevision(revision, rel) {
  const source = `packages/app-bundle/overlay/${rel}`
  const mode = gitText(REPO_ROOT, ["ls-tree", revision, "--", source]).split(/\s+/)[0]
  return { bytes: git(REPO_ROOT, ["show", `${revision}:${source}`], null), symlink: mode === "120000" }
}

function expectedContract(source, baseRef, revision) {
  const base = resolve(source, baseRef)
  const { files, deletions } = changedPaths(source, base, revision)
  const hashes = Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, file]) => [rel, hash(file.bytes)]))
  const symlinks = [...files.entries()].filter(([, file]) => file.symlink).map(([rel]) => rel).sort()
  return { base, files, hashes, symlinks, deletions: [...deletions].sort() }
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch {
    return null
  }
}

function exceptionFiles(manifest, target) {
  const exceptions = manifest?.exceptions ?? []
  if (!Array.isArray(exceptions)) return { error: "manifest exceptions must be an array" }
  const files = {}
  for (const exception of exceptions) {
    if (!exception || typeof exception.path !== "string" || typeof exception.sha256 !== "string" ||
      typeof exception.reason !== "string" || typeof exception.review !== "string") {
      return { error: "each overlay exception needs path, sha256, reason, and review" }
    }
    const file = join(target, exception.path)
    if (!existsSync(file) || fileHash(file) !== exception.sha256) {
      return { error: `reviewed exception does not match the committed overlay: ${exception.path}` }
    }
    files[exception.path] = exception.sha256
  }
  return { files }
}

function verify({ source, revision, target, manifestPath, baseRef }) {
  const manifest = readManifest(manifestPath)
  if (!manifest) return { ok: false, reason: `missing or invalid manifest at ${manifestPath}` }
  if (manifest.schema !== 5) return { ok: false, reason: "manifest schema must be 5; run an overlay-promotion first" }
  if (manifest.fork_sha !== revision) {
    return { ok: false, reason: `manifest records OpenCode ${String(manifest.fork_sha).slice(0, 12)}, checked-out local/amicode is ${revision.slice(0, 12)}. Merge the overlay-promotion commit first.` }
  }
  const base = baseRef ?? manifest.upstream_base_sha ?? manifest.upstream_base
  if (typeof base !== "string" || !base) return { ok: false, reason: "manifest has no upstream_base" }

  let expected
  try {
    expected = expectedContract(source, base, revision)
  } catch (error) {
    return { ok: false, reason: `cannot derive the declared source revision: ${error instanceof Error ? error.message : error}` }
  }
  if (manifest.upstream_base_sha !== expected.base) return { ok: false, reason: "manifest upstream_base_sha does not resolve to its declared base" }
  if (JSON.stringify(manifest.files) !== JSON.stringify(expected.hashes)) return { ok: false, reason: "manifest file hashes do not reproduce the declared OpenCode revision" }
  if (JSON.stringify(manifest.symlinks ?? []) !== JSON.stringify(expected.symlinks)) return { ok: false, reason: "manifest symlink set does not reproduce the declared OpenCode revision" }
  if (JSON.stringify(manifest.deletions) !== JSON.stringify(expected.deletions)) return { ok: false, reason: "manifest deletion set does not reproduce the declared OpenCode revision" }

  const exceptionResult = exceptionFiles(manifest, target)
  if (exceptionResult.error) return { ok: false, reason: exceptionResult.error }
  const expectedFiles = { ...expected.hashes, ...exceptionResult.files }
  const actualFiles = walk(target)
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(expectedFiles).sort())) {
    return { ok: false, reason: "overlay file set contains unexplained drift" }
  }
  for (const [rel, expectedHash] of Object.entries(expectedFiles)) {
    if (fileHash(join(target, rel)) !== expectedHash) return { ok: false, reason: `overlay content does not match its declared hash: ${rel}` }
  }
  for (const rel of expected.symlinks) {
    if (!lstatSync(join(target, rel)).isSymbolicLink()) return { ok: false, reason: `overlay file type does not match the declared source revision: ${rel}` }
  }
  for (const rel of expected.deletions) {
    if (existsSync(join(target, rel)) && !exceptionResult.files[rel]) {
      return { ok: false, reason: `declared deletion remains in the overlay: ${rel}` }
    }
  }
  return { ok: true, expected }
}

function promote({ source, revision, baseRef, target, manifestPath, branch, exceptionPaths, exceptionFrom, exceptionReason, exceptionReview }) {
  const guard = sourceGuard(source, branch, revision)
  if (guard) return fail(`refusing promotion: ${guard}`)
  if (gitText(REPO_ROOT, ["branch", "--show-current"]) === "main") {
    return fail("refusing to write an overlay-promotion directly on Amicode main; use a review branch")
  }
  if (!baseRef) return fail("--base is required for a promotion")

  const previous = readManifest(manifestPath)
  const previousExceptions = exceptionFiles(previous ?? { exceptions: [] }, target)
  if (previousExceptions.error) return fail(previousExceptions.error)
  if (exceptionPaths.length > 0 && (!exceptionFrom || !exceptionReason || !exceptionReview)) {
    return fail("new exceptions require --exception-from, --exception-reason, and --exception-review")
  }
  const expected = expectedContract(source, baseRef, revision)
  for (const rel of Object.keys(previousExceptions.files)) {
    if (expected.files.has(rel)) return fail(`reviewed exception is now fork-owned and must be removed: ${rel}`)
  }
  const exceptions = [...(previous?.exceptions ?? [])]
  const restoredExceptions = new Map()
  for (const rel of exceptionPaths) {
    if (expected.files.has(rel)) return fail(`exception is fork-owned at the promoted revision: ${rel}`)
    if (exceptions.some((exception) => exception.path === rel)) return fail(`exception is already recorded: ${rel}`)
    let file
    try {
      file = fileAtAmicodeRevision(exceptionFrom, rel)
    } catch {
      return fail(`cannot restore exception from Amicode ${exceptionFrom}: ${rel}`)
    }
    restoredExceptions.set(rel, file)
    exceptions.push({ path: rel, sha256: hash(file.bytes), reason: exceptionReason, review: exceptionReview })
  }

  const stage = mkdtempSync(join(tmpdir(), "amicode-overlay-promotion-"))
  const stagedOverlay = join(stage, "overlay")
  try {
    for (const [rel, file] of expected.files) {
      const output = join(stagedOverlay, rel)
      mkdirSync(dirname(output), { recursive: true })
      if (file.symlink) symlinkSync(file.bytes.toString("utf8"), output)
      else writeFileSync(output, file.bytes)
    }
    for (const rel of Object.keys(previousExceptions.files)) {
      const output = join(stagedOverlay, rel)
      mkdirSync(dirname(output), { recursive: true })
      copyFileSync(join(target, rel), output)
    }
    for (const [rel, file] of restoredExceptions) {
      const output = join(stagedOverlay, rel)
      mkdirSync(dirname(output), { recursive: true })
      if (file.symlink) symlinkSync(file.bytes.toString("utf8"), output)
      else writeFileSync(output, file.bytes)
    }

    const manifest = {
      schema: 5,
      scope: "complete fork-vs-base delta of packages/{app,ui,session-ui,schema,core,sdk}",
      fork_ref: previous?.fork_ref ?? branch,
      fork_tag: previous?.fork_tag ?? null,
      fork_sha: revision,
      upstream_base: baseRef,
      upstream_base_sha: expected.base,
      ...(previous?.upstream_base === baseRef && previous.upstream_base_archive_sha256
        ? { upstream_base_archive_sha256: previous.upstream_base_archive_sha256 }
        : {}),
      promoted_at: new Date().toISOString(),
      files: expected.hashes,
      symlinks: expected.symlinks,
      deletions: expected.deletions,
      exceptions,
    }
    const stagedManifest = join(stage, "manifest.json")
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2) + "\n")

    const backup = `${target}.previous`
    rmSync(backup, { recursive: true, force: true })
    if (existsSync(target)) renameSync(target, backup)
    renameSync(stagedOverlay, target)
    renameSync(stagedManifest, manifestPath)
    rmSync(backup, { recursive: true, force: true })
    console.log(`[overlay-promotion] promoted ${Object.keys(expected.hashes).length} files and ${expected.deletions.length} deletions from ${revision.slice(0, 12)}`)
    return 0
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const source = flag("source") ?? process.env.AMICODE_OPENCODE_SRC ?? join(homedir(), "harmoniqs", "opencode")
const target = flag("target") ?? DEFAULT_TARGET
const manifestPath = flag("manifest") ?? DEFAULT_MANIFEST
const revisionArg = flag("revision")
if (!revisionArg) process.exit(fail("--revision is required"))
if (!existsSync(join(source, ".git"))) process.exit(fail(`source checkout not found: ${source}`))

let revision
try {
  revision = resolve(source, revisionArg)
} catch (error) {
  process.exit(fail(`cannot resolve --revision ${revisionArg}: ${error instanceof Error ? error.message : error}`))
}

if (args.includes("--apply")) {
  process.exit(promote({
    source,
    revision,
    baseRef: flag("base"),
    target,
    manifestPath,
    branch: flag("source-branch") ?? DEFAULT_SOURCE_BRANCH,
    exceptionPaths: flags("exception"),
    exceptionFrom: flag("exception-from"),
    exceptionReason: flag("exception-reason"),
    exceptionReview: flag("exception-review"),
  }))
}

const result = verify({ source, revision, target, manifestPath, baseRef: flag("base") })
if (!result.ok) process.exit(fail(result.reason))
console.log(`[overlay-promotion] PASS: ${Object.keys(result.expected.hashes).length} files and ${result.expected.deletions.length} deletions reproduce ${revision.slice(0, 12)}`)
