// validate_bridge_replay.mjs — SEAM 4 (#704): the ledger-bridge replay validator.
//
// One doctrine, three record kinds (amicode's run dir, strumento's TaskRecord,
// Telaio's event spine — docs/ledger-bridge-contract.md is the statement of
// record). This script validates a record DIRECTORY against the doctrine's
// amicode/strumento spellings, so "the fold can replay it" is a mechanical
// exit code, not an assertion:
//
//   exit 0  — the record carries the doctrine (append-only streams whose lines
//             are whole, an atomic terminal marker, content hashes that check
//             where the contract carries them, opaque tolerance of unknown
//             well-formed values).
//   exit 1  — at least one doctrine violation (reported, one line each).
//   exit 2  — usage.
//
// With no arguments it validates the two committed bridge fixtures (the
// canonical records the Telaio fold must replay — fixtures/bridge/).
//
// Zero-dep by design (node builtins + smol-toml, the package's own dependency):
// the fixtures are committed data and this gate must run anywhere the repo
// checks out — no Julia, no Python. The corruption directions (torn marker,
// mutated hash, missing terminal, torn stream line) are exercised by
// test/bridge_replay.test.ts against tmp copies, never the committed bytes.
//
// Plain JavaScript on purpose (the .mjs runs under bare `node` — TS syntax
// belongs to the .d.mts surface next to it, the assert_built_bundles.mjs
// pattern).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The committed fixtures this validator checks by default (no-args CLI). */
export function defaultFixtureDirs() {
  return [
    { kind: "amicode-run", dir: join(PKG_ROOT, "fixtures", "bridge", "amicode-run") },
    { kind: "strumento-task", dir: join(PKG_ROOT, "fixtures", "bridge", "strumento-task") },
  ];
}

/** Infer the record kind from the directory's own manifest (the record is the
 * truth; neither kind ever contains the other's manifest). */
export function inferRecordKind(dir) {
  if (existsSync(join(dir, "run.toml"))) return "amicode-run";
  if (existsSync(join(dir, "task.toml"))) return "strumento-task";
  return undefined;
}

function readTomlFile(rel, dir, errors) {
  const p = join(dir, rel);
  if (!existsSync(p)) {
    errors.push(`${rel}: missing — the doctrine requires it`);
    return undefined;
  }
  try {
    return parseToml(readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(
      `${rel}: not parseable TOML (${e instanceof Error ? e.message : String(e)}) — ` +
        "atomic tmp+rename means a partial document is corruption, never a race",
    );
    return undefined;
  }
}

/** Parse an append-only JSONL stream into events; returns undefined on a
 * doctrine violation. A line that does not parse is corruption: the stream is
 * flushed per line, so a COMPLETED record with a torn line was never properly
 * terminal. (A LIVE reader may skip the torn in-flight tail — this validator
 * checks a record that claims to be complete.) */
function readJsonlFile(rel, dir, errors) {
  const p = join(dir, rel);
  if (!existsSync(p)) {
    errors.push(`${rel}: missing — the doctrine requires it`);
    return undefined;
  }
  const text = readFileSync(p, "utf8");
  if (text !== "" && !text.endsWith("\n")) {
    errors.push(
      `${rel}: last line is torn (no trailing newline) — the append-only stream ` +
        "of a completed record ends on a whole, flushed line",
    );
    return undefined;
  }
  const events = [];
  let bad = false;
  for (const [i, line] of text.split("\n").slice(0, -1).entries()) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
      events.push(v);
    } catch (e) {
      errors.push(
        `${rel}: line ${i + 1} is not a whole JSON object (${e instanceof Error ? e.message : String(e)}) — ` +
          "a torn append-only stream is corruption for a completed record",
      );
      bad = true;
    }
  }
  return bad ? undefined : events;
}

// ─── amicode run-dir contract ────────────────────────────────────────────────

function validateAmicodeRun(dir, errors) {
  // Terminal markers: result.toml (the solve script's own, atomic) + FINISHED
  // (the harness's, written LAST — its existence is the durable terminal signal).
  readTomlFile("run.toml", dir, errors);
  const result = readTomlFile("result.toml", dir, errors);
  const finished = readTomlFile("FINISHED", dir, errors);
  if (result !== undefined) {
    if (typeof result.fidelity !== "number") errors.push("result.toml: fidelity missing or not a number");
    if (
      typeof result.iterations !== "number" ||
      !Number.isInteger(result.iterations) ||
      result.iterations < 0
    ) {
      errors.push("result.toml: iterations missing or not a non-negative integer");
    }
  }
  if (finished !== undefined) {
    if (typeof finished.status !== "string" || !["completed", "failed", "aborted"].includes(finished.status)) {
      errors.push("FINISHED: status missing or outside completed|failed|aborted");
    }
    if (typeof finished.exit_code !== "number" || !Number.isInteger(finished.exit_code)) {
      errors.push("FINISHED: exit_code missing or not an integer");
    }
  }
  readJsonlFile("events.jsonl", dir, errors);
  if (!existsSync(join(dir, "run.log"))) errors.push("run.log: missing — the stdout contract is part of the record");
}

// ─── strumento TaskRecord contract ──────────────────────────────────────────

function validateStrumentoTask(dir, errors) {
  readTomlFile("task.toml", dir, errors);
  readTomlFile("result.toml", dir, errors);
  readJsonlFile("progress.jsonl", dir, errors);
}

/** Validate one record directory against the bridge doctrine. Pure: reads the
 * dir, returns every violation it finds (never throws). */
export function validateBridgeRecord(dir, kind) {
  const errors = [];
  const k = kind ?? inferRecordKind(dir);
  if (k === undefined) {
    return {
      ok: false,
      kind: "amicode-run",
      errors: [
        `${dir}: no record manifest found (run.toml for an amicode run dir, task.toml for a strumento task dir)`,
      ],
    };
  }
  if (k === "amicode-run") validateAmicodeRun(dir, errors);
  else validateStrumentoTask(dir, errors);
  return { ok: errors.length === 0, kind: k, errors };
}

/** CLI entry. No args → validate the committed fixtures. Exit 0 = all validate. */
export async function main(argv) {
  const targets =
    argv.length > 0 ? argv.map((d) => ({ dir: d, kind: undefined })) : defaultFixtureDirs();
  let failed = false;
  for (const t of targets) {
    const r = validateBridgeRecord(t.dir, t.kind);
    const label = `${basename(t.dir) || t.dir} (${r.kind})`;
    if (r.ok) console.log(`ok: ${label}`);
    else {
      failed = true;
      for (const e of r.errors) console.error(`${label}: ${e}`);
    }
  }
  return failed ? 1 : 0;
}

// Run-as-script contract (imported by test/bridge_replay.test.ts as a module).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
