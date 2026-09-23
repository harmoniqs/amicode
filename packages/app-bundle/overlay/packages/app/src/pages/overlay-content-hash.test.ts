import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import { tmpdir } from "node:os"

/** The content hash algorithm from build_binary.mjs — walk overlay files, hash
 *  relPath + content SHA-256, sort by relPath, produce a single digest. This
 *  test exercises the algorithm directly to verify it detects edits. */
function computeOverlayContentHash(overlayDir: string): string {
  const entries: { rel: string; h: string }[] = []
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.isFile()) {
        const rel = full.slice(overlayDir.length + 1)
        const h = createHash("sha256").update(readFileSync(full)).digest("hex")
        entries.push({ rel, h })
      }
    }
  }
  walk(overlayDir)
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  const digest = createHash("sha256")
  for (const { rel, h } of entries) digest.update(`${rel}\0${h}\0`)
  return digest.digest("hex")
}

describe("overlay content-hash staleness detection (build_binary.mjs)", () => {
  let sandbox: string

  test("identical trees produce the same hash", () => {
    sandbox = mkdtempSync(join(tmpdir(), "overlay-hash-test-"))
    const a = join(sandbox, "a")
    const b = join(sandbox, "b")
    mkdirSync(join(a, "sub"), { recursive: true })
    mkdirSync(join(b, "sub"), { recursive: true })
    writeFileSync(join(a, "file.ts"), "const x = 1")
    writeFileSync(join(a, "sub", "nested.ts"), "export default {}")
    writeFileSync(join(b, "file.ts"), "const x = 1")
    writeFileSync(join(b, "sub", "nested.ts"), "export default {}")

    expect(computeOverlayContentHash(a)).toBe(computeOverlayContentHash(b))
    rmSync(sandbox, { recursive: true })
  })

  test("editing a file changes the hash", () => {
    sandbox = mkdtempSync(join(tmpdir(), "overlay-hash-test-"))
    mkdirSync(join(sandbox, "sub"), { recursive: true })
    writeFileSync(join(sandbox, "file.ts"), "const x = 1")
    writeFileSync(join(sandbox, "sub", "nested.ts"), "export default {}")

    const before = computeOverlayContentHash(sandbox)

    // Edit a file (the kind of change that the manifest hash misses)
    writeFileSync(join(sandbox, "file.ts"), "const x = 2 // edited")

    const after = computeOverlayContentHash(sandbox)
    expect(after).not.toBe(before)
    rmSync(sandbox, { recursive: true })
  })

  test("adding a file changes the hash", () => {
    sandbox = mkdtempSync(join(tmpdir(), "overlay-hash-test-"))
    writeFileSync(join(sandbox, "file.ts"), "const x = 1")

    const before = computeOverlayContentHash(sandbox)

    writeFileSync(join(sandbox, "new-file.ts"), "// new")

    const after = computeOverlayContentHash(sandbox)
    expect(after).not.toBe(before)
    rmSync(sandbox, { recursive: true })
  })

  test("deleting a file changes the hash", () => {
    sandbox = mkdtempSync(join(tmpdir(), "overlay-hash-test-"))
    writeFileSync(join(sandbox, "file.ts"), "const x = 1")
    writeFileSync(join(sandbox, "doomed.ts"), "// going away")

    const before = computeOverlayContentHash(sandbox)

    rmSync(join(sandbox, "doomed.ts"))

    const after = computeOverlayContentHash(sandbox)
    expect(after).not.toBe(before)
    rmSync(sandbox, { recursive: true })
  })

  test("file order does not affect the hash (sorted by relPath)", () => {
    sandbox = mkdtempSync(join(tmpdir(), "overlay-hash-test-"))
    const a = join(sandbox, "a")
    const b = join(sandbox, "b")
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    // Write in different order
    writeFileSync(join(a, "zzz.ts"), "last")
    writeFileSync(join(a, "aaa.ts"), "first")
    // Reversed
    writeFileSync(join(b, "aaa.ts"), "first")
    writeFileSync(join(b, "zzz.ts"), "last")

    expect(computeOverlayContentHash(a)).toBe(computeOverlayContentHash(b))
    rmSync(sandbox, { recursive: true })
  })
})
