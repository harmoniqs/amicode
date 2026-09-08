// tex_support.test.ts — TDD tests for the TeX compilation pipeline (#729).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectTexEngine,
  discoverMainFile,
  parseTexErrors,
} from "../src/tex_support";

// ── Fixtures ────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `amicode-tex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function touch(relativePath: string, content = ""): void {
  const full = join(testDir, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ── detectTexEngine ─────────────────────────────────────────────────────────

describe("detectTexEngine", () => {
  it("returns an engine name or null", async () => {
    // This test just verifies the function returns the right shape.
    // On CI without TeX installed, it returns null; locally it may find latexmk.
    const result = await detectTexEngine();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("respects explicit engine override", async () => {
    const result = await detectTexEngine("xelatex");
    // If xelatex is on PATH, it returns "xelatex"; otherwise null
    expect(result === null || result === "xelatex").toBe(true);
  });
});

// ── discoverMainFile ────────────────────────────────────────────────────────

describe("discoverMainFile", () => {
  it("finds a file with \\documentclass", () => {
    touch("paper/main.tex", "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}");
    touch("paper/refs.bib", "@article{foo}");
    touch("paper/chapter.tex", "\\section{Intro}");

    const result = discoverMainFile(join(testDir, "paper"));
    expect(result).toBe("main.tex");
  });

  it("returns null when no \\documentclass is found", () => {
    touch("paper/chapter.tex", "\\section{Intro}");
    touch("paper/refs.bib", "@article{foo}");

    const result = discoverMainFile(join(testDir, "paper"));
    expect(result).toBeNull();
  });

  it("handles empty directory", () => {
    mkdirSync(join(testDir, "empty"), { recursive: true });
    const result = discoverMainFile(join(testDir, "empty"));
    expect(result).toBeNull();
  });

  it("handles non-existent directory", () => {
    const result = discoverMainFile(join(testDir, "nonexistent"));
    expect(result).toBeNull();
  });

  it("finds \\documentclass with options", () => {
    touch("doc/thesis.tex", "\\documentclass[12pt,a4paper]{report}\n\\begin{document}");

    const result = discoverMainFile(join(testDir, "doc"));
    expect(result).toBe("thesis.tex");
  });

  it("picks the first .tex with \\documentclass when multiple exist", () => {
    touch("a.tex", "\\documentclass{article}");
    touch("b.tex", "\\documentclass{book}");

    const result = discoverMainFile(testDir);
    // Should return one of them (alphabetical order expected)
    expect(result === "a.tex" || result === "b.tex").toBe(true);
  });
});

// ── parseTexErrors ──────────────────────────────────────────────────────────

describe("parseTexErrors", () => {
  it("extracts error with file and line", () => {
    const log = `
This is pdfTeX, Version 3.14159265
./main.tex:10: Undefined control sequence.
l.10 \\foobar
`;
    const errors = parseTexErrors(log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].line).toBe(10);
    expect(errors[0].message).toContain("Undefined control sequence");
  });

  it("extracts ! errors from log", () => {
    const log = `
This is pdfTeX
! Missing $ inserted.
<inserted text> 
                $
l.42 some text
`;
    const errors = parseTexErrors(log);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("Missing $ inserted"))).toBe(true);
  });

  it("returns empty array for clean log", () => {
    const log = `
This is pdfTeX
Output written on main.pdf (1 page, 12345 bytes).
Transcript written on main.log.
`;
    const errors = parseTexErrors(log);
    expect(errors).toEqual([]);
  });

  it("handles empty string", () => {
    expect(parseTexErrors("")).toEqual([]);
  });
});
