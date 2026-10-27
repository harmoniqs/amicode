// test_quarantine_gate.test.ts — the A13c test-quarantine gate (#1907,
// scripts/test_quarantine_gate.mjs at the repo root).
//
// Two committed lists (config/test-quarantine/known-fail.txt, known-flaky.txt)
// and a reporter-agnostic gate over a test-result file. Measurement
// `test_quarantine_gate_rejects_new_failure` (spec-20261026-101500-rd-system-v2-1):
//   - a new failure (in neither list) fails the gate;
//   - a known-fail test that PASSES fails the gate (forces removal);
//   - a known-flaky test passes the gate either way;
// plus: an expired known-flaky ttl fails, and every entry must carry a real
// issue ref (`issue:#N` — no placeholders).
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseList,
  parseResults,
  runGate,
} from "../../../scripts/test_quarantine_gate.mjs";

const REPO = join(__dirname, "..", "..", "..");
const GATE = join(REPO, "scripts", "test_quarantine_gate.mjs");
const FX = join(__dirname, "fixtures", "test-quarantine");
const LISTS = join(FX, "lists");
const BAD = join(FX, "lists-bad");
const TODAY = "2026-10-26";

function gate(result: string, extra: { lists?: string; today?: string; runnerExit?: number; suite?: string } = {}) {
  return runGate({
    resultFile: join(FX, "results", result),
    listsDir: extra.lists ?? LISTS,
    suite: extra.suite ?? "fx",
    root: "/ROOT",
    today: extra.today ?? TODAY,
    runnerExit: extra.runnerExit,
  });
}

const kinds = (r: { violations: { kind: string }[] }) => r.violations.map((v) => v.kind).sort();

describe("test quarantine gate (A13c, #1907)", () => {
  test("baseline: known-fail fails, flaky passes, rest green → gate passes", () => {
    const r = gate("green.json");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("a NEW failure (in neither list) fails the gate", () => {
    const r = gate("new-failure.json");
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.objectContaining({ kind: "new-failure", id: "fx::test/a.test.ts::math > adds" }),
    ]);
  });

  test("a known-fail test that PASSES fails the gate (forces removal)", () => {
    const r = gate("known-fail-passes.json");
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.objectContaining({ kind: "known-fail-passed", id: "fx::test/a.test.ts::math > is broken" }),
    ]);
  });

  test("a known-fail test that did not run (skipped/absent) fails the gate — the list must not rot", () => {
    const r = gate("known-fail-skipped.json");
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["known-fail-not-observed"]);
  });

  test("a known-flaky test passes the gate either way", () => {
    expect(gate("green.json").ok).toBe(true); // flaky passed
    expect(gate("flaky-fails.json").ok).toBe(true); // flaky failed
  });

  test("an expired known-flaky ttl fails the gate", () => {
    const r = gate("green.json", { today: "2099-01-02" });
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["flaky-ttl-expired"]);
    // the ttl day itself is still in force
    expect(gate("green.json", { today: "2099-01-01" }).ok).toBe(true);
  });

  test("entries without a real issue ref (missing or placeholder) and flaky without ttl are rejected", () => {
    const r = gate("green.json", { lists: BAD });
    expect(r.ok).toBe(false);
    const invalid = r.violations.filter((v) => v.kind === "invalid-entry");
    expect(invalid).toHaveLength(3);
    expect(invalid.map((v) => v.detail).join("\n")).toMatch(/issue:#N/);
    expect(invalid.map((v) => v.detail).join("\n")).toMatch(/ttl/);
  });

  test("a file-level failure (import error, zero tests collected) is a failure", () => {
    const r = gate("file-level-failure.json");
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.objectContaining({ kind: "new-failure", id: "fx::test/c.test.ts::<file>" }),
    ]);
  });

  test("a non-zero runner exit with no failure in the report fails closed", () => {
    expect(gate("green.json", { runnerExit: 1 }).ok).toBe(true); // known-fail explains the exit
    const r = gate("known-fail-passes.json", { runnerExit: 1, lists: join(FX, "lists") });
    expect(kinds(r)).toContain("runner-failed-unexplained");
  });

  test("entries for other suites are ignored by this suite's run", () => {
    // under suite "other", nothing in the lists applies: a.test.ts::is broken is a new failure
    const r = gate("green.json", { suite: "other" });
    expect(kinds(r)).toEqual(["new-failure"]);
  });

  test("bun junit: nested describe suites form the id; failures and passes are classified", () => {
    const parsed = parseResults(readFileSync(join(FX, "results", "junit-new-failure.xml"), "utf8"), {
      suite: "fx",
    });
    expect(parsed.tests).toEqual([
      { id: "fx::test/a.test.ts::math > is broken", status: "failed" },
      { id: "fx::test/a.test.ts::math > adds & carries", status: "failed" },
      { id: "fx::test/b.test.ts::net > sometimes", status: "passed" },
    ]);
    const r = gate("junit-new-failure.xml");
    expect(r.violations).toEqual([
      expect.objectContaining({ kind: "new-failure", id: "fx::test/a.test.ts::math > adds & carries" }),
    ]);
  });

  test("list parsing: comments and blanks skipped; duplicates rejected; test names may contain '|'", () => {
    const { entries, errors } = parseList(
      ["# c", "", "s::f.ts::a | b | issue:#7", "s::f.ts::a | b | issue:#8"].join("\n"),
      "known-fail",
    );
    expect(entries.map((e) => [e.id, e.issue])).toEqual([["s::f.ts::a | b", 7]]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate/);
  });

  test("CLI: exit 0 on pass, 1 on violation, and the committed repo lists are valid", () => {
    const run = (args: string[]) => {
      try {
        execFileSync("node", [GATE, ...args], { encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    const base = ["--suite", "fx", "--root", "/ROOT", "--today", TODAY, "--lists", LISTS];
    expect(run([...base, join(FX, "results", "green.json")])).toBe(0);
    expect(run([...base, join(FX, "results", "new-failure.json")])).toBe(1);
    expect(run([...base, join(FX, "results", "missing.json")])).toBe(1);
    // the committed lists themselves parse clean (every entry carries a real issue ref)
    for (const kind of ["known-fail", "known-flaky"] as const) {
      const text = readFileSync(join(REPO, "config", "test-quarantine", `${kind}.txt`), "utf8");
      expect(parseList(text, kind).errors).toEqual([]);
    }
  });
});
