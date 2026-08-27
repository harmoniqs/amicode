// Skill-content drift lint (amicode#586). The audit of record (campaign ledger
// session-20260826-issimo-skill-freshness §7.2/§7.3) found that every existing
// skill gate stops at frontmatter shape, set membership, and byte-identity of
// copies — a drifted constructor name in any SKILL.md passed the whole suite
// green. This module is the deterministic content layer:
//
//   extractClaims(SKILL.md)  — conservative, precision-first extraction of API
//                              claims from the body: fenced julia code blocks
//                              (call-position symbols + `using` package context),
//                              backticked symbols (`Pkg.sym`, bang functions,
//                              multi-hump CamelCase), and cited repository paths.
//   checkClaims(claims, …)   — resolves each claim against package checkouts
//                              (`<root>/<Pkg>.jl/…`): export scan + source scan
//                              for symbols, existence for paths. Verdicts are
//                              VERIFIED / DRIFTED / UNVERIFIABLE, each with
//                              evidence (claim location + what was checked).
//   lintSkillsDir(dir, …)    — per-skill report + aggregate. STRUCTURAL failures
//                              (malformed frontmatter, duplicate skill names,
//                              broken relative refs within the skills tree) are
//                              the hard gate; semantic drift is report-mode —
//                              the nightly cadence (issue #587) owns escalation.
//
// Constraints (issue #586): no LLM judgment anywhere in the verdict path
// (anti-gaming), no network, no clock — same input, same report. Dirs arrive as
// arguments; no machine paths live in this module. Extraction errs toward
// precision over recall: a noisy extractor destroys the nightly signal
// downstream, so ambiguous shapes (vault-layout paths, glob templates, Base
// callables, lowercase prose words, file-extension pseudo-qualified names like
// `CONTEXT.md`) are deliberately NOT claims.
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml"; // same parser as scores/package_skills.ts

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimKind = "qualified-symbol" | "symbol" | "path";
export type ClaimSource = "julia-fence" | "backtick" | "link";
export type Verdict = "VERIFIED" | "DRIFTED" | "UNVERIFIABLE";

/** One API claim extracted from a SKILL.md body. `packages` carries the claim's
 *  package scope: the module part of a qualified name, or the `using`/`import`
 *  context of the enclosing julia fence; empty when the claim is unscoped. */
export interface SkillClaim {
  kind: ClaimKind;
  text: string; // the symbol ("solve!") or path ("src/pulses.jl") as cited
  packages: string[];
  line: number; // 1-based line in the SKILL.md file
  source: ClaimSource;
}

export interface ClaimResult {
  claim: SkillClaim;
  verdict: Verdict;
  evidence: string; // what was checked and what was (not) found — deterministic
}

export interface StructuralFailure {
  message: string;
  line?: number;
}

export interface SkillReport {
  skill: string; // directory name under skillsDir
  path: string; // SKILL.md path relative to skillsDir
  name: string | null; // frontmatter name (null when frontmatter is malformed)
  structural: StructuralFailure[];
  claims: ClaimResult[]; // empty under structuralOnly
}

export interface SkillsLintReport {
  skillsDir: string;
  packageRoots: string[];
  structuralOnly: boolean;
  skills: SkillReport[];
  /** Report-level structural failures — not attributable to any one skill
   *  (e.g. the requested skills dir itself is unreadable). */
  topStructural: StructuralFailure[];
  aggregate: {
    skills: number;
    structuralFailures: number;
    verified: number;
    drifted: number;
    unverifiable: number;
  };
  ok: boolean; // true iff zero structural failures (semantic drift never flips this)
}

export interface LintOptions {
  /** CI lane: check structure only — link refs resolve against the skill dir,
   *  no package cross-check at all (CI has no private checkouts). */
  structuralOnly?: boolean;
  /** Strict mode for callers that explicitly named the dir (the CLI, the
   *  nightly cadence): an unreadable skills dir is a structural FAILURE, not
   *  a silently empty report. Library callers scanning optional roots keep
   *  the default (false) behavior. */
  requireSkillsDir?: boolean;
  /** Refuse to report a "clean" run when fewer than this many skills were
   *  linted — lets the nightly consumer distinguish "clean" from "linted
   *  nothing" (an empty-but-existing dir). 0 (the default) = no floor. */
  minSkills?: number;
}

export interface CheckClaimsOptions {
  /** The skill's own directory — first search root for path claims and the
   *  resolution base for relative markdown links. */
  skillDir?: string;
  /** Extra search roots for path claims (library root / repo root / …). */
  searchRoots?: string[];
}

// ---------------------------------------------------------------------------
// Extraction constants — the precision machinery (issue Key Decision)
// ---------------------------------------------------------------------------

/** File extensions a cited path may carry. `packages/Legato.jl`, `docs/x.md`. */
const PATH_EXTENSIONS = new Set([
  "jl", "md", "toml", "json", "jsonl", "yaml", "yml", "jld2", "ts", "js", "mjs", "mts", "txt", "csv",
]);

/** Path prefixes that mark a backticked token as a cited REPOSITORY path (as
 *  opposed to vault-layout references like `sessions/CHECKOUTS.md` or
 *  `catalog/pulses/<id>/metadata.toml`, which are not repo paths and must not
 *  become claims). */
const REPO_PATH_PREFIXES = [
  "src/", "test/", "tests/", "docs/", "doc/", "scripts/", "examples/", "benchmark/", "benchmarks/", "packages/",
];

/** Glob/placeholder characters — a token carrying any of these is a template,
 *  not a concrete path. */
const GLOB_CHARS = /[*?<>{}[\]]/;

/** `..` path segments — a traversal claim escapes the declared roots (review
 *  MAJOR: a SKILL.md citing `src/../../…` must never become a verifiable
 *  claim). Sibling guard of GLOB_CHARS in proseBacktickClaim; the checker
 *  layer containment-checks resolved candidates independently. */
const TRAVERSAL_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

/** Curated Julia Base callables and types. A call to one of these in a fence
 *  (or a backtick in prose) is never a package-API claim. Conservative by
 *  design: anything not listed IS treated as a claim. */
const JULIA_BASE_NAMES = new Set([
  // callables
  "error", "throw", "println", "print", "printstyled", "string", "repr", "symbol", "length", "size",
  "axes", "eachindex", "first", "last", "isempty", "empty!", "push!", "pushfirst!", "pop!", "popat!",
  "append!", "prepend!", "insert!", "delete!", "deleteat!", "get", "get!", "getindex", "setindex!",
  "haskey", "keys", "values", "pairs", "in", "occursin", "isequal", "isapprox", "isnan", "isinf",
  "iszero", "isone", "isnothing", "ismissing", "isassigned", "typeof", "isa", "eltype", "ndims",
  "similar", "copy", "deepcopy", "convert", "promote", "map", "map!", "filter", "filter!", "reduce",
  "sum", "prod", "minimum", "maximum", "extrema", "cumsum", "sort", "sort!", "sortperm", "unique",
  "all", "any", "count", "findall", "findfirst", "findlast", "findnext", "findprev", "argmax",
  "argmin", "include", "eval", "parse", "tryparse", "sleep", "hash", "run", "cd", "pwd", "readdir",
  "mkdir", "mkpath", "rm", "mv", "cp", "touch", "tempname", "download", "read", "write", "readline",
  "readlines", "eachline", "open", "close", "flush", "eof", "lock", "unlock", "wait", "fetch",
  "yield", "exit", "assert", "collect", "iterate", "range", "ones", "zeros", "rand", "randn",
  "vcat", "hcat", "cat", "reshape", "permutedims", "transpose", "adjoint", "norm", "dot", "cross",
  "inv", "det", "eigvals", "exp", "log", "sqrt", "abs", "abs2", "real", "imag", "conj", "angle",
  "max", "min", "clamp", "div", "mod", "rem", "floor", "ceil", "round", "trunc", "foldl", "foldr",
  "scan", "accumulate", "reverse", "repeat", "hstack", "vstack", "display", "show", "dump",
  // types (also denied as prose CamelCase claims)
  "ComplexF64", "ComplexF32", "ComplexF16", "Float64", "Float32", "Float16", "BigFloat", "BigInt",
  "Int128", "Int64", "Int32", "Int16", "Int8", "UInt128", "UInt64", "UInt32", "UInt16", "UInt8",
  "Bool", "Char", "String", "Nothing", "Some", "Missing", "Matrix", "Vector", "AbstractMatrix",
  "AbstractVector", "AbstractArray", "AbstractString", "Array", "Dict", "IdDict", "Set", "BitSet",
  "Tuple", "NamedTuple", "Pair", "UnitRange", "StepRange", "StepRangeLen", "LinRange", "OrdinalRange",
  "Exception", "ErrorException", "ArgumentError", "DimensionMismatch", "BoundsError", "LinearAlgebra",
  "Statistics", "Printf", "Dates", "Logging", "Test", "Random", "Base",
]);

const JULIA_FENCE_RE = /^ {0,3}```\s*(julia|jl)\s*$/i;
const FENCE_CLOSE_RE = /^ {0,3}```\s*$/;
const FENCE_ANY_RE = /^ {0,3}```/;

// ---------------------------------------------------------------------------
// extractClaims
// ---------------------------------------------------------------------------

/** Extract API claims from a SKILL.md (frontmatter stripped, code fences and
 *  prose handled separately). Deterministic; pure function of the markdown. */
export function extractClaims(markdown: string): SkillClaim[] {
  const lines = markdown.split(/\r?\n/);
  const claims: SkillClaim[] = [];
  const seen = new Set<string>();

  const add = (claim: Omit<SkillClaim, "line"> & { line: number }) => {
    const key = `${claim.kind}|${claim.text}|${claim.packages.join(",")}`;
    if (seen.has(key)) return; // first occurrence wins — keeps the report compact
    seen.add(key);
    claims.push(claim);
  };

  let inFrontmatter = false;
  let frontmatterDone = false;
  let fence: { julia: boolean; lines: { text: string; line: number }[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // --- frontmatter ---
    if (!frontmatterDone && i === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === "---" || line === "...") {
        inFrontmatter = false;
        frontmatterDone = true;
      }
      continue; // frontmatter is never a claim source
    }

    // --- fences ---
    if (fence) {
      if (FENCE_CLOSE_RE.test(line)) {
        if (fence.julia) extractFromJuliaFence(fence.lines, add);
        fence = null;
      } else {
        fence.lines.push({ text: line, line: lineNo });
      }
      continue;
    }
    if (FENCE_ANY_RE.test(line)) {
      fence = { julia: JULIA_FENCE_RE.test(line), lines: [] };
      continue;
    }

    // --- prose ---
    extractFromProseLine(line, lineNo, add);
  }
  if (fence?.julia) extractFromJuliaFence(fence.lines, add); // unterminated fence — still harvest
  return claims;
}

/** Harvest call-position symbols + qualified names from a collected julia
 *  fence. `using`/`import` statements provide package context; qualified refs
 *  are only claims when their module part is in that context (else they are
 *  stdlib/foreign references, e.g. `BLAS.set_num_threads` under
 *  `using LinearAlgebra`). String literals are masked first so calls named
 *  inside strings are not claims. */
function extractFromJuliaFence(
  fenceLines: { text: string; line: number }[],
  add: (c: SkillClaim) => void,
): void {
  // pass 1: package context from using/import statements
  const context = new Set<string>();
  for (const { text } of fenceLines) {
    const m = /^\s*(?:using|import)\s+(.+)$/.exec(text);
    if (!m) continue;
    const statement = m[1];
    const scoped = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(statement);
    if (scoped) {
      context.add(scoped[1]);
    } else {
      for (const part of statement.split(",")) {
        const mod = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(part);
        if (mod) context.add(mod[1]);
      }
    }
  }
  for (const { text, line } of fenceLines) {
    // `using Pkg: a, b` — the named imports are explicit API references
    const scoped = /^\s*(?:using|import)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(text);
    if (scoped) {
      for (const name of scoped[2].split(",")) {
        const sym = name.trim();
        if (/^[A-Za-z_][A-Za-z0-9_!]*$/.test(sym) && !JULIA_BASE_NAMES.has(sym)) {
          add({ kind: "symbol", text: sym, packages: [scoped[1]], line, source: "julia-fence" });
        }
      }
    }
    // `import Pkg.Sym` — qualified reference
    const imported = /^\s*import\s+([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_!]*)/.exec(text);
    if (imported) {
      add({ kind: "qualified-symbol", text: `${imported[1]}.${imported[2]}`, packages: [imported[1]], line, source: "julia-fence" });
    }

    const masked = text.replace(/"(?:[^"\\]|\\.)*"/g, (s) => " ".repeat(s.length)); // mask string literals

    // qualified refs — only to modules in this fence's using/import context,
    // and never to Base/stdlib modules (same filter as the prose lane — a
    // `using Test` fence must not mint an UNVERIFIABLE `Test.runtests`)
    const qualified = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_!]*)\b/g;
    let q: RegExpExecArray | null;
    while ((q = qualified.exec(masked))) {
      if (context.has(q[1]) && !isPathLikeExtension(q[2]) && !JULIA_BASE_NAMES.has(q[1])) {
        add({ kind: "qualified-symbol", text: `${q[1]}.${q[2]}`, packages: [q[1]], line, source: "julia-fence" });
      }
    }

    // call-position identifiers (not after a `.` — that is a qualified ref)
    const call = /(^|[^A-Za-z0-9_!.])([A-Za-z_][A-Za-z0-9_!]*)\s*\(/g;
    let c: RegExpExecArray | null;
    while ((c = call.exec(masked))) {
      const sym = c[2];
      if (JULIA_BASE_NAMES.has(sym)) continue;
      add({ kind: "symbol", text: sym, packages: [...context].sort(), line, source: "julia-fence" });
    }
  }
}

/** Harvest claims from one prose line: backticked symbols/paths and relative
 *  markdown links. Link-shaped text inside inline code spans is documentation,
 *  not a link, so backtick spans are masked before link extraction. */
function extractFromProseLine(line: string, lineNo: number, add: (c: SkillClaim) => void): void {
  // 1) backticked spans
  const backtick = /`([^`\n]+)`/g;
  let b: RegExpExecArray | null;
  while ((b = backtick.exec(line))) {
    const t = b[1].trim();
    const claim = proseBacktickClaim(t, lineNo);
    if (claim) add(claim);
  }
  // 2) markdown links, with inline code masked out
  const masked = line.replace(/`[^`\n]*`/g, (s) => " ".repeat(s.length));
  const link = /!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let l: RegExpExecArray | null;
  while ((l = link.exec(masked))) {
    const target = l[2].split("#")[0].trim(); // drop the fragment, if any
    if (target === "" || GLOB_CHARS.test(target)) continue;
    if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#|mailto:)/.test(l[2])) continue; // scheme / protocol-relative / anchor
    add({ kind: "path", text: target, packages: [], line: lineNo, source: "link" });
  }
}

/** Classify one backticked prose token. Conservative by design:
 *  - `A.b` with a capitalized module part and a non-extension symbol part →
 *    qualified symbol (`Piccolo.solve!`); `CONTEXT.md` is NOT one.
 *  - repo-prefixed paths with a known source extension → path claims
 *    (`src/pulses.jl`, `packages/Legato.jl`); vault-layout paths
 *    (`sessions/CHECKOUTS.md`) and glob templates are not claims.
 *  - bang functions (`solve!`) and multi-hump CamelCase (`TransmonSystem`)
 *    → symbol claims; lowercase words and all-caps tokens are not claims. */
function proseBacktickClaim(t: string, lineNo: number): SkillClaim | null {
  // path?
  const normalized = t.replace(/^\.\//, "");
  if (
    normalized.includes("/") &&
    REPO_PATH_PREFIXES.some((p) => normalized.startsWith(p)) &&
    /^[A-Za-z0-9._\-\/]+$/.test(normalized) &&
    !GLOB_CHARS.test(normalized) &&
    !TRAVERSAL_SEGMENT.test(normalized)
  ) {
    const last = normalized.split("/").pop() ?? "";
    const ext = last.includes(".") ? last.split(".").pop()! : "";
    if (ext !== "" && PATH_EXTENSIONS.has(ext)) {
      return { kind: "path", text: t, packages: [], line: lineNo, source: "backtick" };
    }
    return null;
  }
  // qualified symbol?
  const qualified = /^([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_!]*)$/.exec(t);
  if (qualified && !isPathLikeExtension(qualified[2]) && !JULIA_BASE_NAMES.has(qualified[1])) {
    return { kind: "qualified-symbol", text: t, packages: [qualified[1]], line: lineNo, source: "backtick" };
  }
  // bare symbol?
  if (/^[A-Za-z_][A-Za-z0-9_]*!$/.test(t) || /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(t)) {
    if (!JULIA_BASE_NAMES.has(t)) {
      return { kind: "symbol", text: t, packages: [], line: lineNo, source: "backtick" };
    }
  }
  return null;
}

/** `md`, `jl`, … — a bare extension token is a file reference, not a symbol. */
function isPathLikeExtension(s: string): boolean {
  return PATH_EXTENSIONS.has(s.toLowerCase());
}

// ---------------------------------------------------------------------------
// checkClaims
// ---------------------------------------------------------------------------

interface PackageCheckout {
  name: string; // "Piccolo"
  dir: string; // …/Piccolo.jl
}

interface PackageScan {
  juliaFiles: string[]; // absolute, sorted
  exports: Set<string>; // names appearing in `export …` lines
}

/** Discover `<Pkg>.jl` directories under the roots (sorted, root order). */
function discoverPackages(packageRoots: string[]): PackageCheckout[] {
  const out: PackageCheckout[] = [];
  for (const root of packageRoots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // missing root — silently nothing to check against
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".jl")) continue;
      const dir = path.join(root, entry);
      try {
        if (fs.statSync(dir).isDirectory()) out.push({ name: entry.slice(0, -3), dir });
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return out;
}

/** Read (with cache) a package's julia files + export list. The scan covers
 *  `src/` when present (the API surface), else the whole checkout. */
function scanPackage(pkg: PackageCheckout, cache: Map<string, PackageScan>): PackageScan {
  const cached = cache.get(pkg.dir);
  if (cached) return cached;
  const juliaFiles = collectJuliaFiles(path.join(pkg.dir, "src"));
  const files = juliaFiles.length > 0 ? juliaFiles : collectJuliaFiles(pkg.dir);
  const exports = new Set<string>();
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    for (const m of raw.matchAll(/^\s*export\s+(.+)$/gm)) {
      for (const name of m[1].split(/[\s,]+/)) {
        const n = name.trim();
        if (n !== "") exports.add(n);
      }
    }
  }
  const scan = { juliaFiles: files, exports };
  cache.set(pkg.dir, scan);
  return scan;
}

function collectJuliaFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 8) return; // defensive — fixture and package trees are shallow
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jl")) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the first word-boundary occurrence of `symbol` in a package's source.
 *  Returns the package-relative file + 1-based line, or null. */
function findInSource(scan: PackageScan, pkg: PackageCheckout, symbol: string): { file: string; line: number } | null {
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  for (const f of scan.juliaFiles) {
    const raw = fs.readFileSync(f, "utf8");
    const idx = re.exec(raw)?.index;
    if (idx !== undefined) {
      const line = raw.slice(0, idx).split("\n").length;
      return { file: path.relative(pkg.dir, f), line };
    }
  }
  return null;
}

/** Resolve extracted claims against package checkouts (+ optional search
 *  roots). Pure with respect to the filesystem state: no network, no clock. */
export function checkClaims(
  claims: SkillClaim[],
  packageRoots: string[],
  opts: CheckClaimsOptions = {},
): ClaimResult[] {
  const cache = new Map<string, PackageScan>();
  const packages = discoverPackages(packageRoots);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const searchRoots: string[] = [];
  if (opts.skillDir) searchRoots.push(opts.skillDir);
  if (opts.searchRoots) searchRoots.push(...opts.searchRoots);

  return claims.map((claim) => {
    if (claim.kind === "path") return checkPathClaim(claim, packageRoots, packages, searchRoots, opts);
    return checkSymbolClaim(claim, packages, byName, cache);
  });
}

function checkSymbolClaim(
  claim: SkillClaim,
  packages: PackageCheckout[],
  byName: Map<string, PackageCheckout>,
  cache: Map<string, PackageScan>,
): ClaimResult {
  // a qualified claim ("Piccolo.solve!") asserts the RIGHT-hand symbol in the
  // LEFT-hand package — the lookup name never includes the module prefix
  const symbol = claim.kind === "qualified-symbol" ? claim.text.split(".").pop()! : claim.text;
  const scope = claim.packages.length > 0 ? claim.packages : packages.map((p) => p.name).sort();
  if (scope.length === 0) {
    return {
      claim,
      verdict: "UNVERIFIABLE",
      evidence: "no package scope and no package roots given — nothing to check against",
    };
  }
  const missing = scope.filter((n) => !byName.has(n));
  if (missing.length === scope.length) {
    return {
      claim,
      verdict: "UNVERIFIABLE",
      evidence: `package(s) ${missing.map((m) => `${m}.jl`).join(", ")} not found under any package root`,
    };
  }
  if (missing.length > 0) {
    // a context package is absent — drift cannot be proven, only suspected
    return {
      claim,
      verdict: "UNVERIFIABLE",
      evidence: `package(s) ${missing.map((m) => `${m}.jl`).join(", ")} not found under any package root; cannot fully check '${claim.text}'`,
    };
  }
  for (const name of scope) {
    const pkg = byName.get(name)!;
    const scan = scanPackage(pkg, cache);
    if (scan.exports.has(symbol)) {
      return { claim, verdict: "VERIFIED", evidence: `'${claim.text}' is exported by ${pkg.name}.jl` };
    }
    const hit = findInSource(scan, pkg, symbol);
    if (hit) {
      return {
        claim,
        verdict: "VERIFIED",
        evidence: `'${claim.text}' found in ${pkg.name}.jl/${hit.file}:${hit.line} (source scan)`,
      };
    }
  }
  const scopeLabel =
    claim.packages.length > 0
      ? scope.map((n) => `${n}.jl`).join(", ")
      : `any of ${scope.length} package(s) under the given roots`;
  return {
    claim,
    verdict: "DRIFTED",
    evidence: `'${claim.text}' not found in ${scopeLabel} (export list + source scan)`,
  };
}

/** Containment: is `resolved` inside (or equal to) one of the allowed roots?
 *  Guards BOTH the trust verdict and the stat surface: a candidate whose `..`
 *  segments escape every declared root is never VERIFIED and never statted
 *  (review MAJOR — defense in depth behind the extraction guard). */
function isInsideAnyRoot(resolved: string, roots: string[]): boolean {
  for (const root of roots) {
    const base = path.resolve(root);
    if (resolved === base || resolved.startsWith(base + path.sep)) return true;
  }
  return false;
}

function checkPathClaim(
  claim: SkillClaim,
  packageRoots: string[],
  packages: PackageCheckout[],
  searchRoots: string[],
  opts: CheckClaimsOptions,
): ClaimResult {
  const target = claim.text.replace(/^\.\//, "");
  const tried: string[] = [];
  // Every resolved candidate must land inside one of the declared roots
  // (skill dir / search roots / package roots). Candidates that resolve
  // outside are never statted and can never yield VERIFIED.
  const allowedRoots = [...searchRoots, ...packageRoots];
  if (opts.skillDir) allowedRoots.push(opts.skillDir);
  let escaped = 0;

  // relative markdown links resolve against the skill's own directory
  if (claim.source === "link") {
    if (!opts.skillDir) {
      return { claim, verdict: "UNVERIFIABLE", evidence: "relative link with no skill dir given — cannot resolve" };
    }
    const resolved = path.resolve(opts.skillDir, target);
    if (!isInsideAnyRoot(resolved, allowedRoots)) {
      return { claim, verdict: "DRIFTED", evidence: `path resolves outside all declared roots: '${target}'` };
    }
    tried.push(path.relative(opts.skillDir, resolved) || target);
    if (fs.existsSync(resolved)) {
      return {
        claim,
        verdict: "VERIFIED",
        evidence: `relative link resolves: ${path.relative(opts.skillDir, resolved) || target} (skill dir)`,
      };
    }
    return { claim, verdict: "DRIFTED", evidence: `broken relative reference '${target}' — not found under the skill dir` };
  }

  // backticked paths: skill dir / search roots, then package roots (+ <Pkg>.jl/)
  for (const root of searchRoots) {
    const resolved = path.resolve(root, target);
    if (!isInsideAnyRoot(resolved, allowedRoots)) {
      escaped++;
      continue;
    }
    tried.push(`${path.relative(root, resolved) || target} (search root)`);
    if (fs.existsSync(resolved)) {
      const rel = path.relative(root, resolved) || target;
      return {
        claim,
        verdict: "VERIFIED",
        evidence: `path exists: ${rel} (${root === opts.skillDir ? "skill dir" : "search root"})`,
      };
    }
  }
  for (let i = 0; i < packageRoots.length; i++) {
    const root = packageRoots[i];
    const direct = path.resolve(root, target);
    if (!isInsideAnyRoot(direct, allowedRoots)) {
      escaped++;
      continue;
    }
    tried.push(`${target} (package root ${i + 1})`);
    if (fs.existsSync(direct)) {
      return { claim, verdict: "VERIFIED", evidence: `path exists: ${target} (package root ${i + 1})` };
    }
    for (const pkg of packages) {
      if (!pkg.dir.startsWith(root)) continue; // (sep guard lands with the review-NIT fix)
      const inPkg = path.resolve(pkg.dir, target);
      if (!isInsideAnyRoot(inPkg, allowedRoots)) {
        escaped++;
        continue;
      }
      tried.push(`${pkg.name}.jl/${target}`);
      if (fs.existsSync(inPkg)) {
        return { claim, verdict: "VERIFIED", evidence: `path exists: ${pkg.name}.jl/${target} (package root ${i + 1})` };
      }
    }
  }
  if (searchRoots.length === 0 && packageRoots.length === 0) {
    return { claim, verdict: "UNVERIFIABLE", evidence: "no skill dir, search roots, or package roots given" };
  }
  if (escaped > 0) {
    return {
      claim,
      verdict: "DRIFTED",
      evidence: `path resolves outside all declared roots: '${target}' (${escaped} escaping candidate${escaped === 1 ? "" : "s"} not checked)`,
    };
  }
  return {
    claim,
    verdict: "DRIFTED",
    evidence: `path '${target}' not found — checked ${tried.slice(0, 6).join(", ")}${tried.length > 6 ? `, … (${tried.length} candidates)` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// lintSkillsDir
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { name: string; description: string } | { error: string } {
  // CRLF-tolerant: extractClaims splits on /\r?\n/, so only this match was
  // line-ending blind (a \r\n file read as "missing frontmatter" — review MINOR)
  const normalized = raw.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { error: "missing frontmatter block" };
  let fm: unknown;
  try {
    fm = parseYaml(m[1]);
  } catch (e) {
    return { error: `yaml parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const o = fm as { name?: unknown; description?: unknown };
  if (typeof o.name !== "string" || typeof o.description !== "string") {
    return { error: "frontmatter needs string name + description" };
  }
  return { name: o.name, description: o.description };
}

/** Lint a skills directory (one level of `<name>/SKILL.md`, the library shape
 *  of resolveLibrarySkills). Structural failures — malformed frontmatter,
 *  duplicate skill names, broken relative refs within the skills tree — make
 *  `ok` false (the hard gate); semantic drift stays report-mode. */
export function lintSkillsDir(skillsDir: string, packageRoots: string[], opts: LintOptions = {}): SkillsLintReport {
  const structuralOnly = opts.structuralOnly === true;
  const skills: SkillReport[] = [];
  const seenNames = new Map<string, string>(); // frontmatter name → skill dir

  let entries: string[] = [];
  const topStructural: StructuralFailure[] = [];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    entries = [];
    if (opts.requireSkillsDir === true) {
      topStructural.push({ message: `skills dir not readable (requested explicitly): ${skillsDir}` });
    }
    // Otherwise: optional root → empty report, no throw (library-scan mode).
  }

  for (const entry of entries.sort()) {
    const skillPath = path.join(skillsDir, entry, "SKILL.md");
    try {
      if (!fs.statSync(skillPath).isFile()) continue;
    } catch {
      continue; // dir without SKILL.md — not a skill, silently skipped
    }
    const raw = fs.readFileSync(skillPath, "utf8");
    const fm = parseFrontmatter(raw);
    const structural: StructuralFailure[] = [];
    let name: string | null = null;
    if ("error" in fm) {
      structural.push({ message: `malformed frontmatter: ${fm.error}` });
    } else {
      name = fm.name;
      const firstDir = seenNames.get(fm.name);
      if (firstDir !== undefined) {
        structural.push({ message: `duplicate skill name '${fm.name}' (also defined by ${firstDir})` });
      } else {
        seenNames.set(fm.name, entry);
      }
    }

    const skillDir = path.join(skillsDir, entry);
    const claims = extractClaims(raw);
    const linkClaims = claims.filter((c) => c.source === "link");

    // Link refs are structural: they must resolve within the skills tree, in
    // every mode. Everything else is the semantic cross-check (skipped whole
    // under structuralOnly — CI has no private checkouts).
    const toCheck = structuralOnly ? linkClaims : claims;
    const searchRoots = [skillDir, path.dirname(skillsDir), path.dirname(path.dirname(skillsDir))];
    const checked = checkClaims(toCheck, structuralOnly ? [] : packageRoots, { skillDir, searchRoots });

    for (const r of checked) {
      if (r.claim.source === "link" && r.verdict === "DRIFTED") {
        structural.push({ message: `broken relative reference '${r.claim.text}'`, line: r.claim.line });
      }
    }
    // Under structuralOnly ONLY structure is reported — link claims were
    // checked purely for the structural verdict, and the claims array stays
    // empty (the CI lane asserts nothing semantic). Under the full check,
    // broken links surface as structural failures, so they are not
    // double-reported as drifted claims.
    const reported = structuralOnly ? [] : checked.filter((r) => r.claim.source !== "link" || r.verdict !== "DRIFTED");

    skills.push({ skill: entry, path: path.join(entry, "SKILL.md"), name, structural, claims: reported });
  }

  // --min-skills floor (review MINOR): "linted nothing" is not "clean" when
  // the caller asked for a minimum. A report-level structural failure.
  if (opts.minSkills !== undefined && opts.minSkills > 0 && skills.length < opts.minSkills) {
    topStructural.push({ message: `min-skills floor not met: ${skills.length} < ${opts.minSkills}` });
  }

  const aggregate = {
    skills: skills.length,
    structuralFailures:
      skills.reduce((n, s) => n + s.structural.length, 0) + topStructural.length,
    verified: skills.reduce((n, s) => n + s.claims.filter((c) => c.verdict === "VERIFIED").length, 0),
    drifted: skills.reduce((n, s) => n + s.claims.filter((c) => c.verdict === "DRIFTED").length, 0),
    unverifiable: skills.reduce((n, s) => n + s.claims.filter((c) => c.verdict === "UNVERIFIABLE").length, 0),
  };
  return {
    skillsDir,
    packageRoots,
    structuralOnly,
    skills,
    topStructural,
    aggregate,
    ok: aggregate.structuralFailures === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI helpers (pure) — consumed by scripts/skill_drift_lint.mts and unit-tested
// here on CI (node 20 vitest) while the .mts runner needs a type-stripping node.
// ---------------------------------------------------------------------------

export interface CliLintOptions {
  skillsDir: string;
  packageRoots: string[];
  structuralOnly: boolean;
  /** --min-skills floor: fail structurally when fewer skills were linted. */
  minSkills: number;
  reportFormat: "json" | "text";
  outFile?: string;
}

/** Parse CLI arguments. `defaults.defaultSkillsDir` is supplied by the runner
 *  (the in-repo public library) — this module holds no paths of its own. */
export function parseLintArgs(argv: string[], defaults: { defaultSkillsDir: string }): CliLintOptions | { error: string } {
  const opts: CliLintOptions = {
    skillsDir: defaults.defaultSkillsDir,
    packageRoots: [],
    structuralOnly: false,
    minSkills: 0,
    reportFormat: "json",
    outFile: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | undefined => (i + 1 < argv.length ? argv[++i] : undefined);
    if (arg === "--skills") {
      const v = value();
      if (!v) return { error: "--skills requires a directory path" };
      opts.skillsDir = v;
    } else if (arg === "--packages") {
      const v = value();
      if (!v) return { error: "--packages requires at least one root path (comma-separated ok)" };
      for (const p of v.split(",")) {
        if (p.trim() !== "") opts.packageRoots.push(p.trim());
      }
    } else if (arg === "--structural-only") {
      opts.structuralOnly = true;
    } else if (arg === "--min-skills") {
      const v = value();
      if (v === undefined) return { error: "--min-skills requires a number" };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return { error: `--min-skills must be a non-negative integer, got '${v}'` };
      opts.minSkills = n;
    } else if (arg === "--report") {
      const v = value();
      if (v !== "json" && v !== "text") return { error: `--report must be json or text, got '${v ?? ""}'` };
      opts.reportFormat = v;
    } else if (arg === "--out") {
      const v = value();
      if (!v) return { error: "--out requires a file path" };
      opts.outFile = v;
    } else {
      return { error: `unknown argument '${arg}'` };
    }
  }
  return opts;
}

/** Exit code: non-zero ONLY for structural failures — semantic drift is
 *  report-mode (the nightly cadence owns escalation). */
export function lintExitCode(report: SkillsLintReport): number {
  return report.ok ? 0 : 1;
}

/** Short human summary (stderr lane of the CLI). */
export function renderSummary(report: SkillsLintReport): string {
  const a = report.aggregate;
  const lines = [
    `skill-drift-lint: ${a.skills} skills checked (${report.structuralOnly ? "structural only" : "full cross-check"})`,
    `  structural failures: ${a.structuralFailures}`,
    `  claims: ${a.verified} verified · ${a.drifted} drifted · ${a.unverifiable} unverifiable`,
  ];
  for (const f of report.topStructural) lines.push(`  TOP-LEVEL STRUCTURAL: ${f.message}`);
  return lines.join("\n");
}

/** Human-readable full report (the --report text lane). */
export function renderTextReport(report: SkillsLintReport): string {
  const lines: string[] = [];
  for (const s of report.skills) {
    const verdicts = s.claims.reduce<Record<string, number>>((acc, c) => {
      acc[c.verdict] = (acc[c.verdict] ?? 0) + 1;
      return acc;
    }, {});
    const claimBits = Object.entries(verdicts).map(([v, n]) => `${n} ${v.toLowerCase()}`);
    lines.push(`== ${s.skill} (${s.path})${s.name === null ? " [FRONTMATTER UNREADABLE]" : ""} ==`);
    if (s.structural.length > 0) {
      for (const f of s.structural) lines.push(`  STRUCTURAL: ${f.message}${f.line ? ` (line ${f.line})` : ""}`);
    }
    if (s.claims.length > 0) {
      lines.push(`  claims: ${claimBits.join(", ")}`);
      for (const c of s.claims) {
        lines.push(`  ${c.verdict} ${c.claim.text} (line ${c.claim.line}): ${c.evidence}`);
      }
    } else {
      lines.push("  claims: none checked");
    }
    lines.push("");
  }
  lines.push(renderSummary(report));
  return lines.join("\n");
}
