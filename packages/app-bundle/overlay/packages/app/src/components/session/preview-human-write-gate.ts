/**
 * preview-human-write-gate.ts — #1442 AC5
 *
 * Server-side workspace-relative gate for the Preview tab's human write path.
 *
 * This gate is a DISTINCT service-side route/proxy check — NOT the shared
 * engine `file.write` handler (`overlay/.../handlers/file.ts:164`), which
 * deliberately permits absolute paths outside the workspace for the agent
 * capability. Adding an absolute-path rejection there would break the agent.
 *
 * The human Preview write path is narrowed BELOW the raw peer token's reach:
 *   - Workspace-relative paths → allowed (resolved against the workspace root)
 *   - Absolute paths → REJECTED server-side (request never reaches the owner)
 *   - Path traversal escaping the workspace → REJECTED
 *   - Empty paths → REJECTED
 *
 * @module
 */

import * as path from "node:path"

// ── types ────────────────────────────────────────────────────────────────────

/** The result of validating a human write path. */
export type HumanWriteValidation =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: "absolute-path-rejected" | "path-escapes-workspace" | "empty-path" }

// ── validation ───────────────────────────────────────────────────────────────

/** Validate a path for the human Preview write gate.
 *
 *  Rules:
 *  1. Empty path → rejected.
 *  2. Absolute path → rejected (regardless of whether it's inside the workspace).
 *  3. Resolve relative path against workspace root.
 *  4. If resolved path escapes the workspace → rejected.
 *  5. Otherwise → allowed with the resolved absolute path.
 *
 *  This gate is intentionally stricter than the engine's `file.write` handler:
 *  the engine allows absolute paths (agents need them); this gate does NOT. */
export function validateHumanWritePath(filePath: string, workspace: string): HumanWriteValidation {
  // Rule 1: empty path
  if (!filePath || filePath.trim() === "") {
    return { allowed: false, reason: "empty-path" }
  }

  // Rule 2: absolute paths are unconditionally rejected for the human path
  if (path.isAbsolute(filePath)) {
    return { allowed: false, reason: "absolute-path-rejected" }
  }

  // Rule 3: resolve relative to workspace
  const resolved = path.resolve(workspace, filePath)

  // Rule 4: ensure the resolved path is within the workspace
  // The resolved path must start with the workspace root (plus a separator)
  // to prevent ../ traversal escaping the workspace.
  const normalizedWorkspace = workspace.endsWith(path.sep) ? workspace : workspace + path.sep
  if (!resolved.startsWith(normalizedWorkspace) && resolved !== workspace) {
    return { allowed: false, reason: "path-escapes-workspace" }
  }

  // Rule 5: allowed
  return { allowed: true, resolvedPath: resolved }
}
