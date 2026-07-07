import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTailer } from "../src/log_tailer";

// LogTailer is now load-bearing for multi-run DISCOVERY (it tails runs/index),
// not just run.log display — pin the buffering semantics the RunsManager
// depends on: newline-delimited emission, torn-line carry-over, truncation
// reset, and the startOffset contract.

const channel = { appendLine() {}, append() {} } as never;

function harness(content?: string, startOffset = 0) {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  const p = join(dir, "index");
  if (content !== undefined) writeFileSync(p, content);
  const lines: string[] = [];
  const t = new LogTailer({ path: p, startOffset, channel, onLine: (l) => lines.push(l) });
  return { p, t, lines };
}

describe("LogTailer", () => {
  it("emits complete lines once; a torn final line (no newline yet) waits and heals", () => {
    const { p, t, lines } = harness("a\t1\t/s.jl\nb\t2\t/s"); // second line torn mid-write
    t.poke();
    expect(lines).toEqual(["a\t1\t/s.jl"]); // torn tail NOT emitted
    appendFileSync(p, ".jl\nc\t3\t/t.jl\n"); // writer finishes + appends
    t.poke();
    expect(lines).toEqual(["a\t1\t/s.jl", "b\t2\t/s.jl", "c\t3\t/t.jl"]); // healed, no split
    t.dispose();
  });

  it("truncation resets to offset 0 and re-reads (consumers must be idempotent)", () => {
    const { p, t, lines } = harness("one\ntwo\n");
    t.poke();
    expect(lines).toEqual(["one", "two"]);
    writeFileSync(p, "one\n"); // file shrank (rewrite)
    t.poke();
    expect(lines).toEqual(["one", "two", "one"]); // full re-read from 0
    t.dispose();
  });

  it("startOffset skips exactly the replayed bytes (no double-emit, no skipped line)", () => {
    const body = "replayed\n";
    const { p, t, lines } = harness(body + "fresh\n", Buffer.byteLength(body, "utf8"));
    t.poke();
    expect(lines).toEqual(["fresh"]);
    t.dispose();
  });

  it("poke() self-attaches when the file appears after start()", () => {
    const { p, t, lines } = harness(undefined); // file doesn't exist yet
    t.poke();
    expect(lines).toEqual([]);
    writeFileSync(p, "late\n");
    t.poke(); // attaches + drains
    expect(lines).toEqual(["late"]);
    t.dispose();
  });
});
