import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLatexTarget } from "../src/latex_compile";

// #1253: the compile bridge must run latexmk in the .tex file's own directory,
// and must refuse anything outside the workspace/session roots (the parked
// prototype resolved against workspace-folder-0 and used a shell string —
// both wrong). These are the security-critical decisions, kept pure.

describe("resolveLatexTarget", () => {
  const roots = ["/repo", "/other/work"];

  test("accepts a .tex inside a root and derives dir/base/pdf", () => {
    expect(resolveLatexTarget("/repo/paper/main.tex", roots)).toEqual({
      ok: true,
      dir: "/repo/paper",
      base: "main.tex",
      pdf: "/repo/paper/main.pdf",
    });
  });

  test("accepts .ltx too", () => {
    const r = resolveLatexTarget("/repo/a.ltx", roots);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pdf).toBe("/repo/a.pdf");
  });

  test("accepts a file in a second root", () => {
    const r = resolveLatexTarget("/other/work/thesis/ch1.tex", roots);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dir).toBe("/other/work/thesis");
  });

  test("rejects a non-tex extension", () => {
    const r = resolveLatexTarget("/repo/main.md", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a relative path (no guessing a root)", () => {
    const r = resolveLatexTarget("paper/main.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a path outside every root", () => {
    const r = resolveLatexTarget("/etc/passwd.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects a traversal escape out of a root", () => {
    const r = resolveLatexTarget("/repo/../etc/evil.tex", roots);
    expect(r.ok).toBe(false);
  });

  test("rejects when there are no roots", () => {
    const r = resolveLatexTarget("/repo/main.tex", []);
    expect(r.ok).toBe(false);
  });
});

// #1414 (CodeRabbit): the lexical containment check above can be defeated by a
// symlink that sits INSIDE a root but resolves OUTSIDE it. Resolve symlinks
// (best-effort — a not-yet-existing path keeps its lexical form) so a link can't
// point the compile at a file outside the configured roots, and derive the
// compile dir/base from the RESOLVED path.
describe("resolveLatexTarget symlink containment", () => {
  const mk = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "latex-esc-"));

  test("rejects a symlink inside a root that resolves outside it", () => {
    const base = mk();
    try {
      const root = path.join(base, "root");
      const outside = path.join(base, "outside");
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      const secret = path.join(outside, "secret.tex");
      fs.writeFileSync(secret, "\\documentclass{article}");
      const link = path.join(root, "evil.tex");
      fs.symlinkSync(secret, link);

      const r = resolveLatexTarget(link, [root]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not-contained");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("accepts a real .tex inside a root and derives the resolved dir/base/pdf", () => {
    const base = mk();
    try {
      const root = path.join(base, "root");
      fs.mkdirSync(root);
      const file = path.join(root, "main.tex");
      fs.writeFileSync(file, "\\documentclass{article}");

      const r = resolveLatexTarget(file, [root]);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.dir).toBe(fs.realpathSync(root));
        expect(r.base).toBe("main.tex");
        expect(r.pdf).toBe(path.join(fs.realpathSync(root), "main.pdf"));
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("accepts a real .tex reached through a symlinked root (resolves to the same tree)", () => {
    const base = mk();
    try {
      const realRoot = path.join(base, "realroot");
      fs.mkdirSync(realRoot);
      const linkedRoot = path.join(base, "linkedroot");
      fs.symlinkSync(realRoot, linkedRoot);
      const file = path.join(realRoot, "doc.tex");
      fs.writeFileSync(file, "\\documentclass{article}");

      // Root supplied as the symlink; file supplied by its real path — must be
      // recognised as contained once both are resolved.
      const r = resolveLatexTarget(file, [linkedRoot]);
      expect(r.ok).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
