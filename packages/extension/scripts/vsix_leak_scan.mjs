// #2095 — the VSIX leak gate. Computes the would-be VSIX file list with
// `vsce ls --no-dependencies` (the same file selection `vsce package` applies
// in .github/workflows/release.yml — .vscodeignore included) and fails on:
//
//   - any `*.map`                      (source maps are the first thing a
//                                       reverse-engineering agent reads; the
//                                       `!bin/**` re-include once let
//                                       bin/**/*.map back in)
//   - agents/.seed-provenance.json     (machine-provenance records: dev-only,
//   - agents/.deploy-receipt.json       read from the dev checkout, never from
//                                       the installed extension)
//   - a shipped TEXT file containing a developer-machine string
//     (MACHINE_STRINGS below), unless that exact occurrence is named in
//     scripts/vsix_leak_allowlist.txt — the visible-debt list, one line per
//     occurrence. Binary files (NUL in the first 8 KiB) are not scanned.
//
// Usage: node scripts/vsix_leak_scan.mjs [--ext-dir <packages/extension>]
// Exit 0 clean, 1 on any violation (each printed with its file + line).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(PKG_ROOT, "scripts", "vsix_leak_allowlist.txt");

// "vault-aaron" is a personal vault name (a regression guard for the sessions
// default fixed in #2095); '"armonissima"' (quoted, i.e. a code literal) is the
// hardcoded company-vault name — tracked debt, every occurrence allowlisted.
export const MACHINE_STRINGS = ["/home/aaron", "/Users/aaron", "erlich", "vault-aaron", '"armonissima"'];
export const FORBIDDEN_FILES = ["agents/.seed-provenance.json", "agents/.deploy-receipt.json"];

/** The would-be VSIX file list, relative to extDir (vsce's own selection).
 *  `ignoreFile` swaps in an alternative .vscodeignore (the gate's own test
 *  uses it to replay the pre-#2095 `!bin/**` rule and prove detection). */
export function listShippedFiles(extDir = PKG_ROOT, ignoreFile) {
  const vsce = join(dirname(createRequire(resolve(extDir, "package.json")).resolve("@vscode/vsce/package.json")), "vsce");
  const out = execFileSync(process.execPath, [vsce, "ls", "--no-dependencies", ...(ignoreFile ? ["--ignoreFile", ignoreFile] : [])], { cwd: extDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Allowlist lines: `<shipped path> | <exact line substring>  # reason`. */
export function parseAllowlist(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf(" | ");
      if (i < 0) throw new Error(`malformed allowlist line (want "<path> | <needle>"): ${l}`);
      return { file: l.slice(0, i).trim(), needle: l.slice(i + 3).trim() };
    });
}

/** Machine-string hits in one file's text, minus allowlisted occurrences. */
export function scanContent(file, content, allow = []) {
  const needles = allow.filter((a) => a.file === file).map((a) => a.needle);
  return content.split("\n").flatMap((text, i) =>
    MACHINE_STRINGS.filter((m) => text.includes(m))
      .filter(() => !needles.some((n) => text.includes(n)))
      .map((match) => ({ file, kind: "machine-string", match, line: i + 1, text: text.trim().slice(0, 200) })),
  );
}

/** Full gate: list + path rules + content rules. */
export function scanShipped(extDir = PKG_ROOT, opts = {}) {
  const files = listShippedFiles(extDir, opts.ignoreFile);
  const allowlistPath = opts.allowlistPath ?? ALLOWLIST;
  const allow = existsSync(allowlistPath) ? parseAllowlist(readFileSync(allowlistPath, "utf8")) : [];
  const pathViolations = [
    ...files.filter((f) => f.endsWith(".map")).map((file) => ({ file, kind: "source-map" })),
    ...files.filter((f) => FORBIDDEN_FILES.includes(f)).map((file) => ({ file, kind: "provenance-record" })),
  ];
  const contentViolations = files.flatMap((file) => {
    const abs = join(extDir, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) return [];
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return [];
    return scanContent(file, buf.toString("utf8"), allow);
  });
  return { files, violations: [...pathViolations, ...contentViolations] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--ext-dir");
  const result = scanShipped(i > 0 ? process.argv[i + 1] : PKG_ROOT);
  for (const v of result.violations) console.error(`LEAK ${v.kind}: ${v.file}${v.line ? `:${v.line} [${v.match}] ${v.text}` : ""}`);
  console.log(`vsix leak scan: ${result.files.length} files, ${result.violations.length} violation(s)`);
  process.exit(result.violations.length === 0 ? 0 : 1);
}
