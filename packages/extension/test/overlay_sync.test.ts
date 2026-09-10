import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Tests for overlay-sync.mjs — the overlay ↔ fork sync checker.
 *
 * amicode#842: the old suite ran `overlay-sync.mjs --apply` with NO target,
 * which resolved the REAL fork checkout and copied its current branch over
 * packages/app-bundle/overlay/** — ~250 committed files mutated mid-suite,
 * nondeterministically breaking unrelated tests (and the #964 hunk clobbers).
 *
 * These tests never invoke the script against committed state: every
 * invocation aims `--source` and `--target` at a tmp tree. A beforeAll/afterAll
 * hash of the REAL overlay additionally proves the suite leaves it byte-clean.
 */

const SCRIPT = join(__dirname, "..", "..", "app-bundle", "scripts", "overlay-sync.mjs")
const REAL_OVERLAY = join(__dirname, "..", "..", "app-bundle", "overlay")
const APP = ["packages", "app", "src"] as const

// ── fixtures ────────────────────────────────────────────────────────────────

type Files = Record<string, string>

// The known-fixed hunks (#964 fixture list) — present in both source and target
// unless a test deliberately regresses one.
const HEALTHY: Files = {
  "components/prompt-input-v2.tsx": `export const x = promptDesignPlaceholder(\n  mode(),\n  placeholder(),\n)\n`,
  "context/global-sync/session-cache.ts": `const diff_version: Record<string, number | undefined> = {}\ndelete store.diff_version[sessionID]\n`,
  "i18n/en.ts": `export const dict = { "session.exportTrace": "Export trace" }\n`,
  "i18n/de.ts": `export const dict = { "session.exportTrace": "Trace exportieren" }\n`,
}

const GENERIC_OLD = "export const v = 1\n"
const GENERIC_NEW = "export const v = 2\n"

function writeTree(root: string, files: Files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...APP, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

function walkAll(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { recursive: true })) {
    out.push(entry.toString())
  }
  return out.sort()
}

function hashTree(dir: string): string {
  const h = createHash("sha256")
  const walk = (d: string) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isSymbolicLink()) h.update(`L:${abs}:${readlinkSync(abs)}\n`)
      else h.update(`F:${abs}:${readFileSync(abs)}`)
    }
  }
  walk(dir)
  return h.digest("hex")
}

type Fixture = { root: string; source: string; target: string; manifest: string }

function makeFixture(opts: {
  source?: Files
  target?: Files
  branch?: string
  dirty?: boolean
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "overlay-sync-842-"))
  const source = join(root, "source")
  const target = join(root, "overlay")
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  execFileSync("git", ["-C", source, "init", "-b", opts.branch ?? "local/amicode"], { stdio: "pipe" })
  writeTree(source, opts.source ?? HEALTHY)
  const gitId = ["-c", "user.email=test@example.com", "-c", "user.name=OverlaySync Test"]
  execFileSync("git", ["-C", source, ...gitId, "add", "-A"], { stdio: "pipe" })
  execFileSync("git", ["-C", source, ...gitId, "commit", "-m", "init", "--no-verify"], { stdio: "pipe" })
  if (opts.dirty) writeFileSync(join(source, "stray-uncommitted.txt"), "dirty\n")

  writeTree(target, opts.target ?? HEALTHY)

  const manifest: { schema: number; files: Record<string, string> } = { schema: 4, files: {} }
  for (const rel of walkAll(target)) manifest.files[rel] = "stale-hash"
  const manifestPath = join(root, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  return { root, source, target, manifest: manifestPath }
}

function runSync(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const applyArgs = (f: Fixture) => ["--apply", "--source", f.source, "--target", f.target, "--manifest", f.manifest]
const checkArgs = (f: Fixture) => ["--check", "--source", f.source, "--target", f.target, "--manifest", f.manifest]

// ── the suite-hygiene proof (#842 AC) ───────────────────────────────────────

describe("overlay-sync #842 — the suite leaves committed overlay state byte-clean", () => {
  let before: string

  beforeAll(() => {
    before = hashTree(REAL_OVERLAY)
  })

  afterAll(() => {
    // The mutator's whole injury: an ordinary suite run dirtied the real
    // overlay. If this ever fires, the test is invoking the script without a
    // temp --target again.
    expect(hashTree(REAL_OVERLAY), "the overlay test mutated packages/app-bundle/overlay").toBe(before)
  })

  test("a tmp-target --apply does not touch the real overlay", () => {
    const realBefore = hashTree(REAL_OVERLAY)
    const f = makeFixture({ source: { ...HEALTHY, "generic.ts": GENERIC_NEW }, target: { ...HEALTHY, "generic.ts": GENERIC_OLD } })
    try {
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(0)
      expect(hashTree(REAL_OVERLAY)).toBe(realBefore)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("a no-target --check is read-only against the real repo", () => {
    const realBefore = hashTree(REAL_OVERLAY)
    const r = runSync(["--check"])
    // PASS (0) or DRIFT/SKIP (1) are both valid; the point is it wrote nothing.
    expect(r.stdout).toContain("[overlay-sync]")
    expect(r.status).toBeLessThanOrEqual(1)
    expect(hashTree(REAL_OVERLAY)).toBe(realBefore)
  })
})

// ── temp-tree semantics: the script's transformation still runs ─────────────

describe("overlay-sync #842 — temp-tree semantics", () => {
  test("--check on an in-sync tmp tree PASSES without writing", () => {
    const f = makeFixture({})
    try {
      const targetBefore = hashTree(f.target)
      const r = runSync(checkArgs(f))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("PASS")
      expect(hashTree(f.target)).toBe(targetBefore)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("--check on a drifted tmp tree reports DRIFT and writes nothing", () => {
    const f = makeFixture({ source: { ...HEALTHY, "generic.ts": GENERIC_NEW }, target: { ...HEALTHY, "generic.ts": GENERIC_OLD } })
    try {
      const targetBefore = hashTree(f.target)
      const manifestBefore = readFileSync(f.manifest, "utf8")
      const r = runSync(checkArgs(f))
      expect(r.status).toBe(1)
      expect(r.stdout).toContain("DRIFT")
      expect(hashTree(f.target)).toBe(targetBefore)
      expect(readFileSync(f.manifest, "utf8")).toBe(manifestBefore)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("--apply copies fork → target and updates the manifest", () => {
    const f = makeFixture({ source: { ...HEALTHY, "generic.ts": GENERIC_NEW }, target: { ...HEALTHY, "generic.ts": GENERIC_OLD } })
    try {
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("applied 1 file(s)")
      expect(readFileSync(join(f.target, ...APP, "generic.ts"), "utf8")).toBe(GENERIC_NEW)
      const manifest = JSON.parse(readFileSync(f.manifest, "utf8"))
      expect(manifest.files["packages/app/src/generic.ts"]).not.toBe("stale-hash")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("--apply is idempotent — a second run is a no-op", () => {
    const f = makeFixture({ source: { ...HEALTHY, "generic.ts": GENERIC_NEW }, target: { ...HEALTHY, "generic.ts": GENERIC_OLD } })
    try {
      expect(runSync(applyArgs(f)).status).toBe(0)
      const afterFirst = hashTree(f.target)
      const second = runSync(applyArgs(f))
      expect(second.status).toBe(0)
      expect(second.stdout).toContain("already in sync")
      expect(hashTree(f.target)).toBe(afterFirst)
      expect(runSync(checkArgs(f)).stdout).toContain("PASS")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

// ── the amicode-fixes-are-canonical rule (#964, enforced at sync time) ──────

describe("overlay-sync #842 — the known-fixes rule refuses a reverting sync", () => {
  test("refuses a sync that would revert the #929 3-arg translate fix, writing nothing", () => {
    const f = makeFixture({
      source: { ...HEALTHY, "components/prompt-input-v2.tsx": "promptDesignPlaceholder(mode())\n", "generic.ts": GENERIC_NEW },
      target: { ...HEALTHY, "generic.ts": GENERIC_OLD },
    })
    try {
      const targetBefore = hashTree(f.target)
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("REFUSED")
      expect(r.stderr).toContain("#929")
      expect(r.stderr).toContain("prompt-input-v2.tsx")
      expect(hashTree(f.target)).toBe(targetBefore) // nothing copied, not even generic.ts
      expect(readFileSync(join(f.target, ...APP, "generic.ts"), "utf8")).toBe(GENERIC_OLD)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("refuses a sync that would drop exportTrace from one locale, naming it", () => {
    const f = makeFixture({
      source: { ...HEALTHY, "i18n/de.ts": 'export const dict = { "session.other": "x" }\n' },
      target: HEALTHY,
    })
    try {
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("REFUSED")
      expect(r.stderr).toContain("i18n/de.ts")
      expect(r.stderr).toContain("#832")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("--check surfaces a currently-missing known fix", () => {
    const f = makeFixture({ target: { ...HEALTHY, "i18n/de.ts": 'export const dict = { "session.other": "x" }\n' } })
    try {
      const r = runSync(checkArgs(f))
      expect(r.status).toBe(1)
      expect(r.stdout).toContain("known amicode-side fix(es) currently MISSING")
      expect(r.stdout).toContain("i18n/de.ts")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})

// ── the source-branch guard (mirrors #992's pre-flight) ─────────────────────

describe("overlay-sync #842 — the source-branch guard", () => {
  test("refuses when the source checkout is on the wrong branch, writing nothing", () => {
    const f = makeFixture({
      branch: "agent-picker-order",
      source: { ...HEALTHY, "generic.ts": GENERIC_NEW },
      target: { ...HEALTHY, "generic.ts": GENERIC_OLD },
    })
    try {
      const targetBefore = hashTree(f.target)
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("agent-picker-order")
      expect(r.stderr).toContain("local/amicode")
      expect(hashTree(f.target)).toBe(targetBefore)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("refuses when the source checkout is dirty", () => {
    const f = makeFixture({ dirty: true, source: { ...HEALTHY, "generic.ts": GENERIC_NEW }, target: { ...HEALTHY, "generic.ts": GENERIC_OLD } })
    try {
      const r = runSync(applyArgs(f))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("dirty")
      expect(r.stderr).toContain("stash")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("refuses an unverifiable (non-git) source", () => {
    const root = mkdtempSync(join(tmpdir(), "overlay-sync-842-nogit-"))
    const source = join(root, "source")
    const target = join(root, "overlay")
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeTree(source, { ...HEALTHY, "generic.ts": GENERIC_NEW })
    writeTree(target, { ...HEALTHY, "generic.ts": GENERIC_OLD })
    try {
      const r = runSync(["--apply", "--source", source, "--target", target, "--manifest", join(root, "manifest.json")])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("not a git checkout")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a valid override proceeds but is RECORDED", () => {
    const f = makeFixture({
      branch: "agent-picker-order",
      source: { ...HEALTHY, "generic.ts": GENERIC_NEW },
      target: { ...HEALTHY, "generic.ts": GENERIC_OLD },
    })
    try {
      const r = runSync(applyArgs(f), { AMICODE_OVERLAY_SYNC_OVERRIDE: "test: deliberate wrong-branch waiver" })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("OVERRIDE RECORDED")
      expect(readFileSync(join(f.target, ...APP, "generic.ts"), "utf8")).toBe(GENERIC_NEW)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  test("an empty override reason refuses (no silent clobbers)", () => {
    const f = makeFixture({
      branch: "agent-picker-order",
      source: { ...HEALTHY, "generic.ts": GENERIC_NEW },
      target: { ...HEALTHY, "generic.ts": GENERIC_OLD },
    })
    try {
      const r = runSync(applyArgs(f), { AMICODE_OVERLAY_SYNC_OVERRIDE: "" })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("AMICODE_OVERLAY_SYNC_OVERRIDE")
      expect(r.stderr).toContain("empty")
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
