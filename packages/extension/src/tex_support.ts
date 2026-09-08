// tex_support.ts — TeX compilation pipeline for the Preview tab (#729).
//
// Provides:
// - detectTexEngine(): async detection of latexmk/pdflatex/xelatex/lualatex
// - discoverMainFile(): scan for \documentclass in .tex files
// - parseTexErrors(): extract errors from TeX log output
// - compileTeX(): run compilation via the detected engine
//
// Uses which() from amicode_service/run.ts for PATH detection and run() for
// subprocess execution with AbortController support.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { which, run, type RunResult } from "./amicode_service/run";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TexError {
  file?: string;
  line?: number;
  message: string;
}

export interface TexCompileResult {
  success: boolean;
  errors: TexError[];
  log: string;
}

// ── Engine detection ────────────────────────────────────────────────────────

/** Detection chain: latexmk (preferred) > pdflatex > xelatex > lualatex. */
const ENGINE_CHAIN = ["latexmk", "pdflatex", "xelatex", "lualatex"] as const;

/**
 * Detect the best available TeX engine on PATH.
 * If `override` is given, only check that specific engine.
 * Returns the engine name or null if none found.
 */
export async function detectTexEngine(override?: string): Promise<string | null> {
  if (override) {
    return which(override) ? override : null;
  }
  for (const engine of ENGINE_CHAIN) {
    if (which(engine)) return engine;
  }
  return null;
}

// ── Main file discovery ─────────────────────────────────────────────────────

/**
 * Scan a directory for .tex files containing \documentclass.
 * Returns the filename (not full path) of the first match, or null.
 */
export function discoverMainFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const texFiles = entries.filter((f) => f.endsWith(".tex")).sort();

  for (const file of texFiles) {
    try {
      const content = readFileSync(join(dir, file), "utf8");
      if (/\\documentclass(\[.*?\])?\{/.test(content)) {
        return file;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ── Log parsing ─────────────────────────────────────────────────────────────

/**
 * Parse TeX compilation log for errors.
 * Looks for:
 * - `! <error message>` lines (standard TeX errors)
 * - `<file>:<line>: <message>` lines (latexmk/biber style)
 * - `l.<line>` lines (line number context after ! errors)
 */
export function parseTexErrors(log: string): TexError[] {
  const errors: TexError[] = [];
  const lines = log.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern 1: ! Error message
    const bangMatch = line.match(/^!\s+(.+)/);
    if (bangMatch) {
      const message = bangMatch[1];
      // Look ahead for l.<num> to get line number
      let lineNum: number | undefined;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const lMatch = lines[j].match(/^l\.(\d+)/);
        if (lMatch) {
          lineNum = parseInt(lMatch[1], 10);
          break;
        }
      }
      errors.push({ line: lineNum, message });
      continue;
    }

    // Pattern 2: ./file.tex:line: message (latexmk format)
    const fileLineMatch = line.match(/^\.\/(.+?):(\d+):\s+(.+)/);
    if (fileLineMatch) {
      errors.push({
        file: fileLineMatch[1],
        line: parseInt(fileLineMatch[2], 10),
        message: fileLineMatch[3],
      });
    }
  }

  return errors;
}

// ── Compilation ─────────────────────────────────────────────────────────────

/**
 * Compile a TeX file using the detected engine.
 *
 * @param engine - Engine name (latexmk, pdflatex, xelatex, lualatex)
 * @param mainFile - Filename (not full path) relative to cwd
 * @param cwd - Working directory
 * @param abort - AbortSignal to cancel in-flight compilation
 */
export async function compileTeX(
  engine: string,
  mainFile: string,
  cwd: string,
  abort?: AbortSignal,
): Promise<TexCompileResult> {
  const args = buildCompileArgs(engine, mainFile);

  let result: RunResult;
  try {
    result = await run([engine, ...args], { cwd, abort, timeout: 5000 });
  } catch (err) {
    return {
      success: false,
      errors: [{ message: `Compilation failed: ${err instanceof Error ? err.message : "unknown error"}` }],
      log: "",
    };
  }

  const log = result.stdout.toString("utf8") + result.stderr.toString("utf8");
  const errors = parseTexErrors(log);
  const success = result.code === 0 && errors.length === 0;

  return { success, errors, log };
}

/** Build the argument list for a TeX engine. */
function buildCompileArgs(engine: string, mainFile: string): string[] {
  if (engine === "latexmk") {
    return ["-pdf", "-interaction=nonstopmode", "-synctex=1", mainFile];
  }
  // pdflatex, xelatex, lualatex
  return ["-interaction=nonstopmode", "-synctex=1", mainFile];
}
