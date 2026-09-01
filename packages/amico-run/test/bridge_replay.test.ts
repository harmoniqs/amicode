// bridge_replay.test.ts — SEAM 4 (#704): the ledger bridge's replay fixtures.
//
// The amicode half of the cross-repo ledger bridge: two committed, synthetic,
// canonical record dirs (fixtures/bridge/amicode-run + fixtures/bridge/
// strumento-task) that the Telaio fold must replay, and a replay validator
// (scripts/validate_bridge_replay.mjs) that proves the DOCTRINE holds on both
// and breaks on corruption — exit 0 on the fixtures, non-zero on the corrupted
// variants (built in tmp: a torn terminal marker, a mutated content hash, a
// missing terminal marker, a torn append-only stream).
//
// The fixtures are committed DATA, shaped like the real record kinds — no
// Julia, no Python needed to read or replay them. The doctrine itself is
// docs/ledger-bridge-contract.md; a final block greps the note's NAMED
// cross-references (the Telaio criterion, the T4 line, the SEAM 6 datum) so
// the coordination stays honest from the test surface, not just in prose.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBridgeRecord, type BridgeRecordKind } from "../scripts/validate_bridge_replay.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PKG_ROOT));
const BRIDGE_FIXTURES = join(PKG_ROOT, "fixtures", "bridge");
const AMICODE_FIXTURE = join(BRIDGE_FIXTURES, "amicode-run");
// The strumento record dir is named BY ITS ID (the contract: "the id is always
// the directory's basename") — the fixture honors the shape it replays.
const STRUMENTO_FIXTURE = join(BRIDGE_FIXTURES, "2026-08-31-strumento-task-b3a7");

/** Copy a committed fixture to a tmp dir and hand the copy to `mutate` —
 * corruption tests never touch the committed bytes. The copy keeps the
 * fixture's basename (the strumento id contract binds id == basename). */
function mutatedFixture(name: string, kind: "amicode-run" | "strumento-task", mutate: (dir: string) => void): string {
  const src = kind === "amicode-run" ? AMICODE_FIXTURE : STRUMENTO_FIXTURE;
  const dir = join(mkdtempSync(join(tmpdir(), "bridge-replay-")), basename(src));
  cpSync(src, dir, { recursive: true });
  mutate(dir);
  return dir;
}

/** Edit one text file of a record dir in place. */
function edit(dir: string, rel: string, fn: (s: string) => string): void {
  const p = join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

function expectNotOk(dir: string, kind: BridgeRecordKind, matcher?: RegExp): void {
  const r = validateBridgeRecord(dir, kind);
  expect(r.ok).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0);
  if (matcher) expect(r.errors.join("\n")).toMatch(matcher);
}

describe("SEAM 4 corruption detection — the validator fails doctrine violations, not just absence", () => {
  it("amicode: a missing FINISHED (the durable terminal marker) reds", () => {
    const dir = mutatedFixture("no-finished", "amicode-run", (d) => rmSync(join(d, "FINISHED")));
    expectNotOk(dir, "amicode-run", /FINISHED/);
  });

  it("strumento: a missing result.toml (the terminal marker is its EXISTENCE) reds", () => {
    const dir = mutatedFixture("no-result", "strumento-task", (d) => rmSync(join(d, "result.toml")));
    expectNotOk(dir, "strumento-task", /result\.toml/);
  });

  it("amicode: a torn FINISHED (partial TOML from a non-atomic write) reds as corruption, never a race", () => {
    const dir = mutatedFixture("torn-finished", "amicode-run", (d) => {
      writeFileSync(join(d, "FINISHED"), 'status = "compl');
    });
    expectNotOk(dir, "amicode-run", /FINISHED/);
  });

  it("strumento: a torn result.toml (the tmp+rename guarantee means partial is corruption) reds", () => {
    const dir = mutatedFixture("torn-result", "strumento-task", (d) => {
      writeFileSync(join(d, "result.toml"), 'schema = 1\nstate = "do');
    });
    expectNotOk(dir, "strumento-task", /result\.toml/);
  });

  it("amicode: a mutated event hash (last system event no longer matches entities/system.json) reds", () => {
    const dir = mutatedFixture("mutated-hash", "amicode-run", (d) => {
      edit(d, "events.jsonl", (s) =>
        s.replace(
          /"entity":"system","action":"updated".*?"hash":"sha256:[0-9a-f]{64}"/,
          (m) => m.replace(/sha256:[0-9a-f]{8}/, "sha256:deadbeef"),
        ),
      );
    });
    expectNotOk(dir, "amicode-run", /hash/);
  });

  it("amicode: a mutated run.toml [hashes] system_hash (no longer the last system event's hash) reds", () => {
    const dir = mutatedFixture("mutated-manifest-hash", "amicode-run", (d) => {
      edit(d, "run.toml", (s) => s.replace(/system_hash = "sha256:[0-9a-f]{8}/, 'system_hash = "sha256:feedface'));
    });
    expectNotOk(dir, "amicode-run", /system_hash/);
  });

  it("strumento: a malformed calibration content_id (not cfg-<sha256>) reds where the contract carries the hash", () => {
    const dir = mutatedFixture("bad-cfg-id", "strumento-task", (d) => {
      edit(d, "progress.jsonl", (s) => s.replace(/"content_id":\s*"cfg-7903eff0/, '"content_id": "cfg-nothex01'));
    });
    expectNotOk(dir, "strumento-task", /content_id|calibration/);
  });

  it("amicode: a torn final events.jsonl line (in-flight write never terminalized) reds", () => {
    const dir = mutatedFixture("torn-events", "amicode-run", (d) => {
      edit(d, "events.jsonl", (s) => s.slice(0, s.length - 30)); // cut mid-line, no trailing newline
    });
    expectNotOk(dir, "amicode-run", /torn|events\.jsonl/);
  });

  it("strumento: a torn final progress.jsonl line reds for a completed record (a live reader skips it; conformance does not)", () => {
    const dir = mutatedFixture("torn-progress", "strumento-task", (d) => {
      edit(d, "progress.jsonl", (s) => s.slice(0, s.length - 20));
    });
    expectNotOk(dir, "strumento-task", /torn|progress\.jsonl/);
  });

  it("amicode: a non-contiguous seq (an append-only violation: a dropped or replayed line) reds", () => {
    const dir = mutatedFixture("seq-gap", "amicode-run", (d) => {
      edit(d, "events.jsonl", (s) => s.replace('"seq":4', '"seq":9'));
    });
    expectNotOk(dir, "amicode-run", /seq/);
  });

  it("strumento: an artifact event whose path escapes the task dir reds at every boundary", () => {
    const dir = mutatedFixture("artifact-escape", "strumento-task", (d) => {
      edit(d, "progress.jsonl", (s) =>
        s.replace('"path": "artifacts/fit_002.json"', '"path": "../escape.json"'),
      );
    });
    expectNotOk(dir, "strumento-task", /escapes|artifact/);
  });

  it("strumento: an artifact event whose path does not resolve to a real file reds", () => {
    const dir = mutatedFixture("artifact-void", "strumento-task", (d) => {
      rmSync(join(d, "artifacts", "fit_002.json"));
    });
    expectNotOk(dir, "strumento-task", /does not resolve|artifact/);
  });
});

describe("SEAM 4 contract note — the coordination cross-references are grep-able, not vibes", () => {
  // docs/ledger-bridge-contract.md is the statement of record for the shared
  // doctrine. Its NAMED cross-references are load-bearing for the OTHER
  // campaigns (Telaio's criterion is theirs; SEAM 6's datum is the parallel
  // slice's) — this keeps the coordination honest from the test surface.
  const NOTE = join(REPO_ROOT, "docs", "ledger-bridge-contract.md");

  it("the note exists and is published in the docs contents", () => {
    expect(existsSync(NOTE)).toBe(true);
    const readme = readFileSync(join(REPO_ROOT, "docs", "README.md"), "utf8");
    expect(readme).toContain("ledger-bridge-contract.md");
  });

  it("names the Telaio-side criterion as THEIRS, sequenced behind T4 (the fold replays both fixtures)", () => {
    const note = readFileSync(NOTE, "utf8");
    expect(note).toContain("t4_fold_replays_fixtures");
    expect(note).toMatch(/T4/);
    expect(note).toContain("amicode-run");
    expect(note).toContain("strumento-task");
  });

  it("states the F3 non-arrival reduction (if T4 slips, the seam completes as note + fixtures)", () => {
    const note = readFileSync(NOTE, "utf8");
    expect(note).toMatch(/F3/);
    expect(note).toMatch(/non-arrival|slips/);
  });

  it("names Telaio's event spine elements (LEDGER_SCHEMA_VERSION, the unknown-event carrying rule, the closed union)", () => {
    const note = readFileSync(NOTE, "utf8");
    expect(note).toContain("LEDGER_SCHEMA_VERSION");
    expect(note).toMatch(/unknown-event/i);
    expect(note).toMatch(/closed event union|closed union/i);
  });

  it("cross-references the SEAM 6 one-autonomy datum (device: none | ro | rw, the P4 gate, Telaio's bounds)", () => {
    const note = readFileSync(NOTE, "utf8");
    expect(note).toMatch(/none \| ro \| rw/);
    expect(note).toMatch(/P4/);
    expect(note).toMatch(/warrant/i);
  });

  it("names the validator and both fixture paths (the fold's entry points)", () => {
    const note = readFileSync(NOTE, "utf8");
    expect(note).toContain("packages/amico-run/scripts/validate_bridge_replay.mjs");
    expect(note).toContain("packages/amico-run/fixtures/bridge/amicode-run");
    expect(note).toContain("packages/amico-run/fixtures/bridge/2026-08-31-strumento-task-b3a7");
  });
});

describe("SEAM 4 validator CLI — the exit code is the contract", () => {
  it("no args: validates both committed fixtures, exit 0", () => {
    const r = spawnSync(process.execPath, [join(PKG_ROOT, "scripts", "validate_bridge_replay.mjs")], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("amicode-run");
    expect(r.stdout).toContain("strumento-task");
  });

  it("a corrupted record dir as arg: exit 1 with the violation on stderr", () => {
    const dir = mutatedFixture("cli-corrupt", "amicode-run", (d) => rmSync(join(d, "FINISHED")));
    const r = spawnSync(process.execPath, [join(PKG_ROOT, "scripts", "validate_bridge_replay.mjs"), dir], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FINISHED/);
  });

  it("a real record dir as arg: exit 0 (the fold invokes the validator per record)", () => {
    const r = spawnSync(process.execPath, [join(PKG_ROOT, "scripts", "validate_bridge_replay.mjs"), STRUMENTO_FIXTURE], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

describe("SEAM 4 opacity — unknown-but-well-formed values skip, never fail (the forward-compat axis)", () => {
  it("amicode: an appended event with an unknown entity/action still validates (readers pass through)", () => {
    const dir = mutatedFixture("unknown-entity", "amicode-run", (d) => {
      edit(d, "events.jsonl", (s) =>
        s +
        '{"seq":7,"ts":"2026-08-31T12:05:00.000Z","entity":"campaign","action":"noted","diff":{"topic":{"from":null,"to":"future-kind"}},"provenance":null}\n',
      );
    });
    const r = validateBridgeRecord(dir, "amicode-run");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("strumento: an unknown manifest kind still validates (a future axis value reads, derives, and lists)", () => {
    const dir = mutatedFixture("unknown-kind", "strumento-task", (d) => {
      edit(d, "task.toml", (s) => s.replace('kind = "experiment"', 'kind = "monitor"'));
    });
    const r = validateBridgeRecord(dir, "strumento-task");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("strumento: the canonical fixture's own unknown ev value (the carried forward-compat probe) validates by design", () => {
    // the committed progress.jsonl ends with an unknown "survey" event — the
    // fixture EXERCISES the opacity rule so the fold's replay is held to it
    const raw = readFileSync(join(STRUMENTO_FIXTURE, "progress.jsonl"), "utf8");
    expect(raw).toContain('"ev": "survey"');
    const r = validateBridgeRecord(STRUMENTO_FIXTURE, "strumento-task");
    expect(r.ok).toBe(true);
  });
});

describe("SEAM 4 amicode stdout contract — run.log carries the live-telemetry lines", () => {
  it("a missing AMICODE_PULSE_META reds (the Inspector's live plot is dead without it)", () => {
    const dir = mutatedFixture("no-meta", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace(/^AMICODE_PULSE_META.*\n/m, ""));
    });
    expectNotOk(dir, "amicode-run", /AMICODE_PULSE_META/);
  });

  it("two AMICODE_PULSE_META lines red (it is emitted exactly once, before the solve)", () => {
    const dir = mutatedFixture("double-meta", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace("AMICODE_ITER iter=1", s.split("\n")[0] + "\nAMICODE_ITER iter=1"));
    });
    expectNotOk(dir, "amicode-run", /AMICODE_PULSE_META/);
  });

  it("an AMICODE_ITER line torn out of grammar reds", () => {
    const dir = mutatedFixture("bad-iter", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace("AMICODE_ITER iter=30", "AMICODE_ITER iteration=30"));
    });
    expectNotOk(dir, "amicode-run", /AMICODE_ITER/);
  });

  it("a DONE fidelity that disagrees with result.toml reds (the number never travels without its pair)", () => {
    const dir = mutatedFixture("done-mismatch", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace("DONE fidelity=0.9995", "DONE fidelity=0.4242"));
    });
    expectNotOk(dir, "amicode-run", /DONE|fidelity/);
  });

  it("iter numbers that go backwards red (the stats row replays the stream in order)", () => {
    const dir = mutatedFixture("iter-regress", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace("AMICODE_ITER iter=30", "AMICODE_ITER iter=1")); // 1,1,60 — a replayed iter
    });
    expectNotOk(dir, "amicode-run", /iter/);
  });

  it("a DONE line that is not the last stdout line reds", () => {
    const dir = mutatedFixture("late-done", "amicode-run", (d) => {
      edit(d, "run.log", (s) => s.replace("DONE fidelity=0.9995", "DONE fidelity=0.9995\npost-done noise"));
    });
    expectNotOk(dir, "amicode-run", /DONE/);
  });
});

describe("SEAM 4 replay fixtures — the canonical records validate", () => {
  it("the committed amicode run-dir fixture is present and validates against the doctrine", () => {
    expect(existsSync(join(AMICODE_FIXTURE, "run.toml"))).toBe(true);
    const r = validateBridgeRecord(AMICODE_FIXTURE, "amicode-run");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("the committed strumento task-dir fixture is present and validates against the doctrine", () => {
    expect(existsSync(join(STRUMENTO_FIXTURE, "task.toml"))).toBe(true);
    const r = validateBridgeRecord(STRUMENTO_FIXTURE, "strumento-task");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
