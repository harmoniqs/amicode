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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBridgeRecord, type BridgeRecordKind } from "../scripts/validate_bridge_replay.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(PKG_ROOT);
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
