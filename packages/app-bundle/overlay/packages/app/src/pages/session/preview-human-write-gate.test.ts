/**
 * preview-human-write-gate.test.ts — #1442 AC5
 *
 * Tests the server-side workspace-relative gate for the Preview tab's human
 * write path. This gate is SEPARATE from the shared engine `file.write` handler
 * (which deliberately allows absolute paths for agents).
 *
 * The gate validates:
 *   - Workspace-relative paths → allowed, forwarded to the owner
 *   - Absolute paths → rejected server-side (request never reaches the owner)
 *   - Path traversal (../) out of workspace → rejected
 */
import { describe, expect, test } from "bun:test"
import {
  validateHumanWritePath,
  type HumanWriteValidation,
} from "../../components/session/preview-human-write-gate"

describe("preview human write gate (#1442 AC5)", () => {
  const workspace = "/home/user/project"

  test("a workspace-relative path is allowed", () => {
    const result = validateHumanWritePath("src/main.ts", workspace)
    expect(result.allowed).toBe(true)
    expect(result.resolvedPath).toBe("/home/user/project/src/main.ts")
  })

  test("a simple filename is allowed", () => {
    const result = validateHumanWritePath("README.md", workspace)
    expect(result.allowed).toBe(true)
    expect(result.resolvedPath).toBe("/home/user/project/README.md")
  })

  test("an absolute path is rejected server-side", () => {
    const result = validateHumanWritePath("/etc/passwd", workspace)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("absolute-path-rejected")
  })

  test("an absolute path inside the workspace is still rejected (must be relative)", () => {
    const result = validateHumanWritePath("/home/user/project/src/main.ts", workspace)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("absolute-path-rejected")
  })

  test("a path with ../ that escapes the workspace is rejected", () => {
    const result = validateHumanWritePath("../../etc/passwd", workspace)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("path-escapes-workspace")
  })

  test("a path with ../ that stays in the workspace is allowed", () => {
    const result = validateHumanWritePath("src/../lib/util.ts", workspace)
    expect(result.allowed).toBe(true)
    expect(result.resolvedPath).toBe("/home/user/project/lib/util.ts")
  })

  test("an empty path is rejected", () => {
    const result = validateHumanWritePath("", workspace)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe("empty-path")
  })

  test("the gate is distinct from the engine file.write handler (contract assertion)", () => {
    // The shared engine file.write handler (file.ts:164) allows absolute paths
    // for agents. This gate is a SEPARATE service-side route/proxy check that
    // does NOT modify the shared handler. We verify the gate rejects what the
    // shared handler would allow.
    const absOutsideWorkspace = validateHumanWritePath("/tmp/agent-output.txt", workspace)
    expect(absOutsideWorkspace.allowed).toBe(false)
    expect(absOutsideWorkspace.reason).toBe("absolute-path-rejected")
  })
})
