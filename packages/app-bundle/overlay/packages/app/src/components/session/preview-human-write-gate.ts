/**
 * preview-human-write-gate.ts — #1442 AC5, extended by #1454 (W5)
 *
 * Browser-safe workspace-containment gate for the human Preview / review-panel
 * write path. It runs in the webview, so — like preview-file-helpers.ts — it
 * uses plain string operations, NOT `node:path` (which is not available in the
 * browser bundle).
 *
 * The gate is applied UPSTREAM of the shared engine `file.write` handler
 * (`overlay/.../handlers/file.ts`), which deliberately permits absolute paths
 * for the agent capability — the handler body is NEVER edited. This gate narrows
 * only the HUMAN write path:
 *   - relative paths        → resolved against the workspace root and allowed
 *   - absolute INSIDE the ws → normalized and allowed (Preview paths are often
 *                              absolute: preview-file-helpers.ts:11-21)
 *   - anything OUTSIDE the ws → rejected (never reaches the owner)
 *   - empty paths            → rejected
 * The agent's in-process write (tool/write.ts) is out of scope and untouched.
 *
 * @module
 */

import { isAbsolutePreviewPath } from "./preview-file-helpers"

// ── types ────────────────────────────────────────────────────────────────────

/** The result of validating a human write path. */
export type HumanWriteValidation =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: "path-escapes-workspace" | "empty-path" }

// ── validation ───────────────────────────────────────────────────────────────

/** Collapse "." / ".." segments and unify separators to POSIX "/" — a
 *  browser-safe stand-in for `path.resolve`/`path.normalize`. */
function normalizePosix(p: string): string {
  const isAbs = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return (isAbs ? "/" : "") + out.join("/")
}

/** Validate a path for the human Preview/review write gate.
 *
 *  Rules:
 *  1. Empty path → rejected.
 *  2. Resolve to an absolute path: an already-absolute path is taken as-is; a
 *     relative path is joined onto the workspace root.
 *  3. Normalize "." / ".." segments.
 *  4. If the resolved path is inside the workspace (or equals it) → allowed with
 *     the normalized absolute path; otherwise → rejected as escaping the
 *     workspace.
 *
 *  Unlike the engine's `file.write` handler (which allows absolute paths for
 *  agents), this gate accepts an absolute path ONLY when it resolves inside the
 *  workspace — the human path is narrowed below the raw peer token's reach. */
export function validateHumanWritePath(filePath: string, workspace: string): HumanWriteValidation {
  // Rule 1: empty path
  if (!filePath || filePath.trim() === "") {
    return { allowed: false, reason: "empty-path" }
  }

  const ws = normalizePosix(workspace)

  // Rule 2: resolve to an absolute candidate
  const candidateRaw = isAbsolutePreviewPath(filePath)
    ? filePath
    : `${ws.replace(/\/+$/, "")}/${filePath}`

  // Rule 3: normalize
  const resolved = normalizePosix(candidateRaw)

  // Rule 4: containment — must be the workspace root or inside it
  const wsWithSep = ws.endsWith("/") ? ws : ws + "/"
  if (resolved === ws || resolved.startsWith(wsWithSep)) {
    return { allowed: true, resolvedPath: resolved }
  }
  return { allowed: false, reason: "path-escapes-workspace" }
}
