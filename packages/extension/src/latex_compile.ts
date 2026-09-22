// latex_compile — pure target resolution for the LaTeX compile bridge (#1253).
//
// The compile bridge runs `latexmk` in a saved .tex file's OWN directory, and
// must refuse any path outside the workspace/session roots. That containment
// decision — plus deriving the companion .pdf path — is kept here, away from the
// child_process/vscode wiring in chat_bridge.ts. Containment resolves symlinks
// (#1414) so a link inside a root cannot point the compile at a file outside it.

import * as fs from "node:fs";
import * as path from "node:path";

export type LatexTarget =
  | { ok: true; dir: string; base: string; pdf: string }
  | { ok: false; reason: "not-tex" | "not-absolute" | "not-contained" };

/** Is `file` inside `root` (or equal to it), without a `..` escape? */
function contained(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks best-effort. An existing path (including a symlink) resolves
 * to its real location so containment can't be defeated by a link; a not-yet-
 * existing path keeps its normalized lexical form — there is no symlink to
 * escape through, and latexmk fails on a missing file anyway.
 */
function realOrNormal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(p);
  }
}

/**
 * Resolve a save-triggered compile target. Accepts only an absolute `.tex`/
 * `.ltx` path contained in one of `roots`; returns its directory (the compile
 * cwd), basename (the latexmk argument), and companion `.pdf` path. Both the
 * file and each root are symlink-resolved before the containment check, and the
 * derived dir/base come from the resolved path.
 */
export function resolveLatexTarget(file: string, roots: readonly string[]): LatexTarget {
  if (!/\.(tex|ltx)$/i.test(file)) return { ok: false, reason: "not-tex" };
  if (!path.isAbsolute(file)) return { ok: false, reason: "not-absolute" };
  const resolved = realOrNormal(file);
  if (!roots.some((root) => contained(realOrNormal(root), resolved))) {
    return { ok: false, reason: "not-contained" };
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const pdf = path.join(dir, base.replace(/\.(tex|ltx)$/i, ".pdf"));
  return { ok: true, dir, base, pdf };
}
