#!/usr/bin/env node
// test_quarantine_gate.mjs — the A13c test-quarantine gate (#1907,
// spec-20261026-101500-rd-system-v2-1 decision A13(c)).
//
// Two committed lists under config/test-quarantine/:
//   known-fail.txt   tests that MUST fail; each entry carries an issue ref.
//   known-flaky.txt  tests that may pass or fail; issue ref + ttl.
// One entry per line, `#` comments and blank lines ignored:
//   <suite>::<file>::<describe > ... > title> | issue:#N [| ttl:YYYY-MM-DD]
// (ttl is required on known-flaky and refused on known-fail).
//
// The gate reads one test-result file — vitest `--reporter=json` output, or
// any JUnit XML (bun test `--reporter=junit`, vitest `--reporter=junit`) — and
// FAILS (exit 1) when:
//   - a test failed that is in neither list            (new-failure)
//   - a known-fail test passed                          (known-fail-passed: remove it)
//   - a known-fail test was not observed failing        (known-fail-not-observed: stale entry)
//   - a known-flaky entry's ttl is before today (UTC)   (flaky-ttl-expired)
//   - a list entry is malformed / lacks a real issue ref (invalid-entry)
//   - the runner exited non-zero but the report shows no failure at all
//     (runner-failed-unexplained: fail closed on crashes/unhandled errors)
// A known-flaky test passes the gate either way. Entries naming another
// suite are ignored for this run (except validation, which is global).
//
// Usage:
//   node scripts/test_quarantine_gate.mjs [--suite <name>] [--root <dir>]
//        [--lists <dir>] [--today YYYY-MM-DD] [--runner-exit <code>] <result-file>
// --suite defaults to the unscoped name of the package that owns the first
// test file (vitest json) — e.g. @amicode/amico-run → amico-run; --root (where
// file paths are made relative) defaults to that package dir.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LISTS_DIR = join(REPO, "config", "test-quarantine");

const ISSUE_RE = /^issue:#(\d+)$/;
const TTL_RE = /^ttl:(\d{4}-\d{2}-\d{2})$/;
const FIELD_RE = /^(issue|ttl):/;

function validDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parse one list. kind: "known-fail" | "known-flaky". */
export function parseList(text, kind) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const where = `${kind}.txt:${i + 1}`;
    // trailing ` | issue:… | ttl:…` fields are peeled from the right, so a
    // test name may itself contain " | ".
    const parts = line.split(" | ");
    const fields = [];
    while (parts.length > 1 && FIELD_RE.test(parts[parts.length - 1].trim())) {
      fields.unshift(parts.pop().trim());
    }
    const id = parts.join(" | ").trim();
    let issue = null;
    let ttl = null;
    const problems = [];
    if (id.split("::").length < 3 || id.split("::").some((p) => !p.trim())) {
      problems.push("id must be <suite>::<file>::<test name>");
    }
    for (const f of fields) {
      let m;
      if ((m = ISSUE_RE.exec(f))) {
        if (issue !== null) problems.push("duplicate issue field");
        issue = Number(m[1]);
      } else if ((m = TTL_RE.exec(f)) && validDate(m[1])) {
        if (ttl !== null) problems.push("duplicate ttl field");
        ttl = m[1];
      } else {
        problems.push(`malformed field \`${f}\``);
      }
    }
    if (issue === null || issue <= 0) problems.push("missing issue ref — every entry needs `issue:#N` (a real issue number)");
    if (kind === "known-flaky" && ttl === null) problems.push("known-flaky entry needs `ttl:YYYY-MM-DD`");
    if (kind === "known-fail" && ttl !== null) problems.push("known-fail entries carry no ttl (they must fail until fixed)");
    if (!problems.length && seen.has(id)) problems.push(`duplicate entry for ${id}`);
    if (problems.length) {
      errors.push(`${where}: ${problems.join("; ")} — \`${line}\``);
      return;
    }
    seen.add(id);
    entries.push({ id, issue, ttl, kind, line: i + 1 });
  });
  return { entries, errors };
}

// ── result parsing ────────────────────────────────────────────────────────

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function parseJunit(text, suite) {
  const tests = [];
  const stack = []; // open <testsuite> names; stack[0] is the file-level suite
  let current = null; // open <testcase>
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  for (const m of text.matchAll(tagRe)) {
    const [, close, name, rawAttrs, selfClose] = m;
    if (!name) continue;
    if (name === "testsuite") {
      if (close) stack.pop();
      else if (!selfClose) stack.push(attrs(rawAttrs));
    } else if (name === "testcase") {
      if (close) {
        if (current) tests.push(current.done());
        current = null;
      } else {
        const a = attrs(rawAttrs);
        const file = a.file ?? stack[0]?.file ?? stack[0]?.name ?? a.classname ?? "<unknown>";
        const names = [...stack.slice(1).map((s) => s.name), a.name];
        let status = "passed";
        const tc = {
          set: (s) => (status = status === "failed" ? status : s),
          done: () => ({ id: `${suite}::${file}::${names.join(" > ")}`, status }),
        };
        if (selfClose) tests.push(tc.done());
        else current = tc;
      }
    } else if (current && !close && (name === "failure" || name === "error")) {
      current.set("failed");
    } else if (current && !close && name === "skipped") {
      current.set("skipped");
    }
  }
  return tests;
}

function findPackageDir(file) {
  let dir = dirname(file);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function unscoped(pkgDir) {
  try {
    const name = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).name;
    return typeof name === "string" && name ? name.replace(/^@[^/]+\//, "") : null;
  } catch {
    return null;
  }
}

function parseVitestJson(json, suite, root) {
  if (!json || !Array.isArray(json.testResults)) throw new Error("not a vitest/jest json report (no testResults[])");
  const first = json.testResults[0]?.name;
  if ((!suite || !root) && first && isAbsolute(first)) {
    const pkg = findPackageDir(first);
    if (pkg) {
      root ??= pkg;
      suite ??= unscoped(pkg);
    }
  }
  if (!suite) throw new Error("cannot infer --suite; pass it explicitly");
  const rel = (f) => {
    const r = root && isAbsolute(f) ? relative(root, f) : f;
    return r.split(sep).join("/");
  };
  const tests = [];
  for (const file of json.testResults) {
    const f = rel(file.name);
    const results = file.assertionResults ?? [];
    for (const a of results) {
      const name = [...(a.ancestorTitles ?? []), a.title].join(" > ");
      const status = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      tests.push({ id: `${suite}::${f}::${name}`, status });
    }
    // a file that failed without any failing test (import error, hook crash,
    // zero tests collected) is a failure in its own right
    if (file.status === "failed" && !results.some((a) => a.status === "failed")) {
      tests.push({ id: `${suite}::${f}::<file>`, status: "failed" });
    }
  }
  return { suite, tests };
}

/** Parse a result file's text. Auto-detects JUnit XML vs vitest json. */
export function parseResults(text, { suite, root } = {}) {
  if (text.trimStart().startsWith("<")) {
    if (!suite) throw new Error("JUnit input needs an explicit --suite");
    return { suite, tests: parseJunit(text, suite) };
  }
  return parseVitestJson(JSON.parse(text), suite, root);
}

// ── evaluation ────────────────────────────────────────────────────────────

export function evaluateGate({ suite, tests, knownFail, knownFlaky, listErrors = [], today, runnerExit }) {
  const violations = listErrors.map((detail) => ({ kind: "invalid-entry", id: null, detail }));
  const prefix = `${suite}::`;
  const kf = new Map(knownFail.filter((e) => e.id.startsWith(prefix)).map((e) => [e.id, e]));
  const fl = new Map(knownFlaky.filter((e) => e.id.startsWith(prefix)).map((e) => [e.id, e]));
  for (const e of knownFlaky) {
    if (e.ttl < today) violations.push({ kind: "flaky-ttl-expired", id: e.id, detail: `ttl ${e.ttl} < ${today} (issue #${e.issue}) — fix it, or re-justify with a new ttl` });
  }
  const observed = new Map();
  for (const t of tests) {
    const prev = observed.get(t.id);
    // the same id twice (duplicate names): any failure wins
    observed.set(t.id, prev === "failed" ? prev : t.status);
  }
  let anyFailed = false;
  for (const [id, status] of observed) {
    if (status === "failed") anyFailed = true;
    if (fl.has(id)) continue;
    if (kf.has(id)) {
      if (status === "passed") violations.push({ kind: "known-fail-passed", id, detail: `known-fail now passes — remove it from known-fail.txt (issue #${kf.get(id).issue})` });
      continue;
    }
    if (status === "failed") violations.push({ kind: "new-failure", id, detail: "failed and is in neither quarantine list" });
  }
  for (const [id, e] of kf) {
    const s = observed.get(id);
    if (s === undefined || s === "skipped") violations.push({ kind: "known-fail-not-observed", id, detail: `known-fail ${s === undefined ? "absent from the run" : "skipped"} — must fail; remove or fix the entry (issue #${e.issue})` });
  }
  if (runnerExit !== undefined && runnerExit !== 0 && !anyFailed) {
    violations.push({ kind: "runner-failed-unexplained", id: null, detail: `runner exited ${runnerExit} but the report shows no failing test (crash / unhandled error?)` });
  }
  const counts = { total: observed.size, failed: [...observed.values()].filter((s) => s === "failed").length };
  return { ok: violations.length === 0, suite, violations, counts };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function runGate({ resultFile, listsDir = DEFAULT_LISTS_DIR, suite, root, today = todayUtc(), runnerExit }) {
  const lists = {};
  const listErrors = [];
  for (const kind of ["known-fail", "known-flaky"]) {
    const p = join(listsDir, `${kind}.txt`);
    if (!existsSync(p)) {
      listErrors.push(`${kind}.txt: missing at ${p}`);
      lists[kind] = [];
      continue;
    }
    const { entries, errors } = parseList(readFileSync(p, "utf8"), kind);
    lists[kind] = entries;
    listErrors.push(...errors);
  }
  const both = new Set(lists["known-fail"].map((e) => e.id));
  for (const e of lists["known-flaky"]) if (both.has(e.id)) listErrors.push(`${e.id}: listed in both known-fail and known-flaky`);
  let parsed;
  try {
    parsed = parseResults(readFileSync(resultFile, "utf8"), { suite, root });
  } catch (err) {
    return { ok: false, suite, counts: { total: 0, failed: 0 }, violations: [{ kind: "unreadable-report", id: null, detail: `${resultFile}: ${err.message}` }] };
  }
  return evaluateGate({ ...parsed, knownFail: lists["known-fail"], knownFlaky: lists["known-flaky"], listErrors, today, runnerExit });
}

function main(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--suite") opts.suite = val();
    else if (a === "--root") opts.root = resolve(val());
    else if (a === "--lists") opts.listsDir = resolve(val());
    else if (a === "--today") opts.today = val();
    else if (a === "--runner-exit") opts.runnerExit = Number(val());
    else if (a === "-h" || a === "--help") {
      console.log("usage: test_quarantine_gate.mjs [--suite S] [--root DIR] [--lists DIR] [--today YYYY-MM-DD] [--runner-exit N] <result-file>");
      return 0;
    } else pos.push(a);
  }
  if (pos.length !== 1) {
    console.error("test-quarantine-gate: exactly one result file required");
    return 2;
  }
  const r = runGate({ resultFile: resolve(pos[0]), ...opts });
  const tag = `test-quarantine-gate[${r.suite ?? "?"}]`;
  for (const v of r.violations) console.error(`${tag} FAIL ${v.kind}${v.id ? ` ${v.id}` : ""}: ${v.detail}`);
  console.log(`${tag} ${r.ok ? "OK" : "FAIL"}: ${r.counts.total} tests, ${r.counts.failed} failed, ${r.violations.length} violation(s)`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`test-quarantine-gate: ${err.message}`);
    process.exitCode = 2;
  }
}
