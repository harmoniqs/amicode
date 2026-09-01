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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBridgeRecord, type BridgeRecordKind } from "../scripts/validate_bridge_replay.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(PKG_ROOT);
const BRIDGE_FIXTURES = join(PKG_ROOT, "fixtures", "bridge");
const AMICODE_FIXTURE = join(BRIDGE_FIXTURES, "amicode-run");
const STRUMENTO_FIXTURE = join(BRIDGE_FIXTURES, "strumento-task");

/** Copy a committed fixture to a tmp dir and hand the copy to `mutate` —
 * corruption tests never touch the committed bytes. */
function mutatedFixture(name: string, kind: "amicode-run" | "strumento-task", mutate: (dir: string) => void): string {
  const dir = join(mkdtempSync(join(tmpdir(), "bridge-replay-")), name);
  cpSync(join(BRIDGE_FIXTURES, kind), dir, { recursive: true });
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

describe("SEAM 4 replay fixtures — the canonical records validate", () => {
  it("the committed amicode run-dir fixture is present and validates against the doctrine", () => {
    expect(existsSync(join(AMICODE_FIXTURE, "run.toml"))).toBe(true);
    const r = validateBridgeRecord(AMICODE_FIXTURE, "amicode-run");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
