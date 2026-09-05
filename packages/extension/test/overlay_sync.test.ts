import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

/**
 * Tests for overlay-sync.mjs — the overlay ↔ fork sync checker.
 *
 * These test the script's behavior, not the current sync state (which
 * depends on whether other PRs have landed on the fork since the last
 * extraction).
 */

const SCRIPT = join(__dirname, "..", "..", "app-bundle", "scripts", "overlay-sync.mjs")

describe("overlay-sync script", () => {
  test("--check runs without crashing and produces structured output", () => {
    // The script exits 0 (PASS/SKIP) or 1 (DRIFT). Both are valid.
    // Only a crash (exit > 1 or thrown error) is a test failure.
    let stdout: string
    let exitCode: number

    try {
      stdout = execFileSync("node", [SCRIPT, "--check"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      exitCode = 0
    } catch (e: any) {
      stdout = e.stdout ?? ""
      exitCode = e.status ?? 1
    }

    // Should produce recognizable output
    expect(stdout).toContain("[overlay-sync]")
    // Exit code 0 = PASS/SKIP, 1 = DRIFT (both acceptable)
    expect(exitCode).toBeLessThanOrEqual(1)
  })

  test("--check reports fork path", () => {
    let stdout: string
    try {
      stdout = execFileSync("node", [SCRIPT, "--check"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e: any) {
      stdout = e.stdout ?? ""
    }

    // Should resolve and report the fork path (or SKIP if not found)
    const hasForkPath = stdout.includes("fork:") || stdout.includes("SKIP")
    expect(hasForkPath).toBe(true)
  })

  test("--apply runs without crashing", () => {
    // We don't actually want to mutate files in the test, so we verify
    // the script at least parses and finds the fork. If there's drift,
    // it will apply it — that's fine, we want the overlay in sync anyway.
    let exitCode: number
    let stdout: string
    try {
      stdout = execFileSync("node", [SCRIPT, "--apply"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      exitCode = 0
    } catch (e: any) {
      stdout = e.stdout ?? ""
      exitCode = e.status ?? 1
    }

    expect(stdout).toContain("[overlay-sync]")
    expect(exitCode).toBe(0)
  })

  test("--check after --apply reports PASS", () => {
    // After apply, check should pass (all files now match the fork)
    let stdout: string
    let exitCode: number

    // First apply
    try {
      execFileSync("node", [SCRIPT, "--apply"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      // apply may exit non-zero if fork not found
    }

    // Then check
    try {
      stdout = execFileSync("node", [SCRIPT, "--check"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      exitCode = 0
    } catch (e: any) {
      stdout = e.stdout ?? ""
      exitCode = e.status ?? 1
    }

    // After apply, everything should be in sync
    const passed = stdout.includes("PASS") || stdout.includes("SKIP")
    expect(passed).toBe(true)
    expect(exitCode).toBe(0)
  })
})
