/**
 * preview-human-write-gate.test.ts — #1442 AC5, extended by #1454 (W5)
 *
 * The human Preview / review-panel write gate. #1454 (W5) resolves the abs-path
 * fork toward NORMALIZE-AND-ACCEPT — an absolute path that lands INSIDE the
 * workspace is accepted (normalized); only writes resolving OUTSIDE the
 * workspace are rejected. Preview paths are legitimately absolute
 * (preview-file-helpers.ts:11-21), so a blanket absolute-reject would break real
 * writes. The gate is browser-safe (no node:path) because it runs in the
 * webview, and it is mounted UPSTREAM of the shared engine file.write handler at
 * both human callers (Preview + review panel); the agent's in-process write
 * (tool/write.ts) is out of scope.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateHumanWritePath } from "../../components/session/preview-human-write-gate"

describe("preview human write gate (#1442 AC5 / #1454 W5)", () => {
  const workspace = "/home/user/project"

  test("a workspace-relative path is allowed", () => {
    const result = validateHumanWritePath("src/main.ts", workspace)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.resolvedPath).toBe("/home/user/project/src/main.ts")
  })

  test("a simple filename is allowed", () => {
    const result = validateHumanWritePath("README.md", workspace)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.resolvedPath).toBe("/home/user/project/README.md")
  })

  test("an absolute path OUTSIDE the workspace is rejected", () => {
    const result = validateHumanWritePath("/etc/passwd", workspace)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe("path-escapes-workspace")
  })

  // #1454: the fork is resolved toward normalize-and-accept — this SUPERSEDES
  // the #1442 "abs-inside rejected" assertion (Preview paths are often absolute).
  test("an absolute path INSIDE the workspace is normalized and accepted", () => {
    const result = validateHumanWritePath("/home/user/project/src/main.ts", workspace)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.resolvedPath).toBe("/home/user/project/src/main.ts")
  })

  test("a relative path with ../ that escapes the workspace is rejected", () => {
    const result = validateHumanWritePath("../../etc/passwd", workspace)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe("path-escapes-workspace")
  })

  test("a relative path with ../ that stays in the workspace is allowed", () => {
    const result = validateHumanWritePath("src/../lib/util.ts", workspace)
    expect(result.allowed).toBe(true)
    if (result.allowed) expect(result.resolvedPath).toBe("/home/user/project/lib/util.ts")
  })

  test("an absolute path that traverses back out of the workspace is rejected", () => {
    const result = validateHumanWritePath("/home/user/project/../secret.txt", workspace)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe("path-escapes-workspace")
  })

  test("an empty path is rejected", () => {
    const result = validateHumanWritePath("", workspace)
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toBe("empty-path")
  })

  test("the gate is browser-safe — no node:path import (it runs in the webview)", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../components/session/preview-human-write-gate.ts"),
      "utf8",
    )
    expect(/from\s+["']node:path["']/.test(src)).toBe(false)
    expect(/require\(\s*["']node:path["']\s*\)/.test(src)).toBe(false)
  })
})

// #1454: the gate must have LIVE (non-test) importers — both human write callers
// (Preview + review panel) — killing its dead-module status. The shared engine
// file.write handler is gated UPSTREAM (at these callers), never edited.
describe("preview human write gate is mounted at both human callers (#1454 W5)", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")

  test("preview-file-view imports and applies the gate before writing", () => {
    const src = read("../../components/session/preview-file-view.tsx")
    expect(src.includes("preview-human-write-gate")).toBe(true)
    expect(src.includes("validateHumanWritePath(")).toBe(true)
  })

  test("the review panel imports and applies the gate before writing", () => {
    const src = read("./v2/review-panel-v2.tsx")
    expect(src.includes("preview-human-write-gate")).toBe(true)
    expect(src.includes("validateHumanWritePath(")).toBe(true)
  })
})
