// Julia import scan (spec C gate step 2) — extract root package names from a
// script's `using`/`import` lines and check them against the entitlement
// allowlist ∪ the fixed support set ∪ the Julia stdlibs. Conservative stance:
// anything else blocks the launch with a one-line reason. `@eval using X`,
// imports in function bodies / `begin` blocks, and `;`-joined statements are
// scanned; dynamic loading forms it cannot parse fail CLOSED. Fails CLOSED on
// multi-line continuations (`using A,\n B`) — a per-line scanner would
// silently pass the continuation, and that is the one adversarial bypass;
// the templates/skeletons all use one statement per line.

export const JULIA_STDLIBS = new Set([
  "LinearAlgebra",
  "Random",
  "Statistics",
  "SparseArrays",
  "Printf",
  "TOML",
  "Dates",
  "Test",
  "Pkg",
  "Serialization",
  "SHA",
  "Logging",
  "Markdown",
  "UUIDs",
  "Distributed",
  "InteractiveUtils",
  "Base64",
  "Unicode",
  "REPL",
  "DelimitedFiles",
  "Mmap",
  "Sockets",
  "Downloads",
  "FileWatching",
  "Libdl",
  "Profile",
]);

export type ScanResult = { ok: true; roots: string[] } | { ok: false; reason: string };
export type CheckResult = { ok: true } | { ok: false; reason: string };

// Matched per `;`-separated statement. An optional `@eval` prefix (also
// `@eval(...)`) and `begin` opener are part of the pattern: the `@eval using X`
// + `Base.invokelatest` idiom and one-line `begin using X end` blocks must not
// hide X from the scan. Indented lines (function bodies, multi-line blocks)
// match because leading whitespace is allowed.
const IMPORT_LINE = /^\s*(?:begin\s+)?(?:@eval\s*\(?\s*)?(?:begin\s+)?(using|import)\s+(.+)$/;

// Package-loading forms the line pattern cannot parse (`Base.require`,
// quoted `:(using X)`, `Expr(:using, …)`, `@eval Mod using X`). They fail
// CLOSED, like multi-line continuations, so a script cannot get a clean scan
// for a package the scanner never saw.
const DYNAMIC_IMPORT = /\brequire\s*\(|:\(\s*(?:using|import)\b|Expr\(\s*:(?:using|import)\b|@eval\b.*\b(?:using|import)\b/;

/** Strip a trailing comment (naive: templates never put `#` inside strings on import lines). */
function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

export function scanImports(script: string): ScanResult {
  const roots: string[] = [];
  const statements = script.split("\n").flatMap((rawLine) => stripComment(rawLine).split(";"));
  for (const line of statements) {
    const match = IMPORT_LINE.exec(line);
    if (!match) {
      if (DYNAMIC_IMPORT.test(line))
        return { ok: false, reason: `dynamic package loading not supported — use a plain using/import: ${line.trim()}` };
      continue;
    }
    const payload = match[2].trim();
    if (payload.endsWith(","))
      return { ok: false, reason: "multi-line using/import not supported — one statement per line" };
    for (const item of payload.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const root = trimmed.split(/[.:\s()]/, 1)[0];
      if (root && !roots.includes(root)) roots.push(root);
    }
  }
  return { ok: true, roots };
}

export function checkImports(roots: string[], allow: { allowlist: string[]; support_set: string[] }): CheckResult {
  const permitted = new Set([...allow.allowlist, ...allow.support_set, ...JULIA_STDLIBS]);
  const blocked = roots.filter((root) => !permitted.has(root));
  if (blocked.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `${blocked.join(", ")}: not in the allowed package set (entitlement allowlist ∪ support set ∪ stdlibs)`,
  };
}
