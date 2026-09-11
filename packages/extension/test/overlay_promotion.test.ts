import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, test } from "vitest"

const SCRIPT = join(__dirname, "..", "..", "app-bundle", "scripts", "overlay-promotion.mjs")
const BUNDLE_PACKAGE = join(__dirname, "..", "..", "app-bundle", "package.json")

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function write(root: string, rel: string, text: string) {
  const target = join(root, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function git(source: string, args: string[]) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overlay-promotion-"))
  const source = join(root, "source")
  const overlay = join(root, "overlay")
  const manifest = join(root, "manifest.json")
  mkdirSync(source, { recursive: true })
  execFileSync("git", ["-C", source, "init", "-b", "local/amicode"], { stdio: "pipe" })
  const author = ["-c", "user.email=test@example.com", "-c", "user.name=Overlay Promotion Test"]

  write(source, "packages/app/src/kept.ts", "export const kept = 1\n")
  write(source, "packages/app/src/deleted.ts", "export const deleted = true\n")
  symlinkSync("kept.ts", join(source, "packages/app/src/link.ts"))
  git(source, [...author, "add", "."])
  git(source, [...author, "commit", "-m", "base", "--no-verify"])
  const base = git(source, ["rev-parse", "HEAD"])

  write(source, "packages/app/src/kept.ts", "export const kept = 2\n")
  write(source, "packages/app/src/added.ts", "export const added = true\n")
  rmSync(join(source, "packages/app/src/link.ts"))
  symlinkSync("added.ts", join(source, "packages/app/src/link.ts"))
  execFileSync("git", ["-C", source, "rm", "packages/app/src/deleted.ts"], { stdio: "pipe" })
  git(source, [...author, "add", "."])
  git(source, [...author, "commit", "-m", "promotion", "--no-verify"])
  const revision = git(source, ["rev-parse", "HEAD"])

  return { root, source, overlay, manifest, base, revision }
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" })
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

describe("overlay promotion", () => {
  test("documents executable read-only check and explicit promotion commands", () => {
    const pkg = JSON.parse(readFileSync(BUNDLE_PACKAGE, "utf8"))
    expect(pkg.scripts["sync:check"]).toBe("node scripts/overlay-promotion.mjs --check")
    expect(pkg.scripts["sync:apply"]).toBe("node scripts/overlay-promotion.mjs --apply")
  })

  test("promotes and verifies a complete revision-pinned overlay including additions and deletions", () => {
    const f = fixture()
    try {
      const args = [
        "--apply",
        "--source", f.source,
        "--revision", f.revision,
        "--base", f.base,
        "--target", f.overlay,
        "--manifest", f.manifest,
      ]
      expect(run(args)).toMatchObject({ status: 0 })

      const generated = JSON.parse(readFileSync(f.manifest, "utf8"))
      expect(generated.fork_sha).toBe(f.revision)
      expect(generated.upstream_base_sha).toBe(f.base)
      expect(generated.files).toEqual({
        "packages/app/src/added.ts": hash("export const added = true\n"),
        "packages/app/src/kept.ts": hash("export const kept = 2\n"),
        "packages/app/src/link.ts": hash("added.ts"),
      })
      expect(generated.deletions).toEqual(["packages/app/src/deleted.ts"])
      expect(existsSync(join(f.overlay, "packages/app/src/deleted.ts"))).toBe(false)
      expect(generated.symlinks).toEqual(["packages/app/src/link.ts"])
      expect(lstatSync(join(f.overlay, "packages/app/src/link.ts")).isSymbolicLink()).toBe(true)

      expect(run(["--check", ...args.slice(1)])).toMatchObject({ status: 0 })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("refuses stale provenance before a main rebuild can continue", () => {
    const f = fixture()
    try {
      write(f.overlay, "packages/app/src/kept.ts", "export const kept = 2\n")
      writeFileSync(f.manifest, JSON.stringify({
        schema: 5,
        fork_sha: "not-the-checked-out-revision",
        upstream_base: f.base,
        upstream_base_sha: f.base,
        files: { "packages/app/src/kept.ts": hash("export const kept = 2\n") },
        deletions: [],
        exceptions: [],
      }, null, 2))

      const result = run(["--check", "--source", f.source, "--revision", f.revision, "--target", f.overlay, "--manifest", f.manifest])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("overlay-promotion commit")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("refuses a dirty source and leaves the target untouched", () => {
    const f = fixture()
    try {
      write(f.source, "scratch.ts", "uncommitted\n")
      const result = run([
        "--apply", "--source", f.source, "--revision", f.revision, "--base", f.base,
        "--target", f.overlay, "--manifest", f.manifest,
      ])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("dirty")
      expect(existsSync(f.overlay)).toBe(false)
      expect(existsSync(f.manifest)).toBe(false)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
