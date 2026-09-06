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
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** amicode's canonical JSON (entities.ts, mirrored): recursively key-sorted,
 * `recorded`/`notes` excluded (clock + prose never churn identity), undefined
 * dropped. The hash input behind every `sha256:` content hash in the record. */
function canonicalJson(value) {
  const HASH_EXCLUDED_KEYS = new Set(["recorded", "notes"]);
  const rec = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(rec);
    const out = {};
    for (const key of Object.keys(v).sort()) {
      if (HASH_EXCLUDED_KEYS.has(key)) continue;
      const val = v[key];
      if (val === undefined) continue;
      out[key] = rec(val);
    }
    return out;
  };
  return JSON.stringify(rec(value));
}

const entityHash = (v) => "sha256:" + sha256Hex(canonicalJson(v));

/** The committed fixtures this validator checks by default (no-args CLI). */
export function defaultFixtureDirs() {
  return [
    { kind: "amicode-run", dir: join(PKG_ROOT, "fixtures", "bridge", "amicode-run") },
    { kind: "strumento-task", dir: join(PKG_ROOT, "fixtures", "bridge", "2026-08-31-strumento-task-b3a7") },
    { kind: "sota-staging", dir: join(PKG_ROOT, "fixtures", "bridge", "2026-09-05-sota-staging") },
  ];
}

/** Infer the record kind from the directory's own manifest (the record is the
 * truth; no kind ever contains another's manifest). */
export function inferRecordKind(dir) {
  if (existsSync(join(dir, "run.toml"))) return "amicode-run";
  if (existsSync(join(dir, "task.toml"))) return "strumento-task";
  if (existsSync(join(dir, "staging.toml"))) return "sota-staging";
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
  const manifest = readTomlFile("run.toml", dir, errors);
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
  const events = readJsonlFile("events.jsonl", dir, errors);

  // Append-only shape: monotonic seq from 1 (seq IS the line count at write
  // time — a gap or repeat is an append-only violation, not a cosmetic issue).
  // Unknown entity/action values are opaque: they skip, never fail.
  const lastHashByEntity = new Map();
  if (events !== undefined) {
    events.forEach((e, i) => {
      if (e.seq !== i + 1) errors.push(`events.jsonl: line ${i + 1} seq is ${e.seq} — seq is monotonic from 1 (append-only)`);
      if (typeof e.ts !== "string" || !ISO_RE.test(e.ts)) errors.push(`events.jsonl: line ${i + 1} ts missing or not ISO-8601`);
      if (typeof e.entity !== "string" || e.entity === "") errors.push(`events.jsonl: line ${i + 1} entity missing`);
      if (typeof e.action !== "string" || e.action === "") errors.push(`events.jsonl: line ${i + 1} action missing`);
      if (e.hash !== undefined) {
        if (typeof e.hash !== "string" || !SHA256_RE.test(e.hash)) errors.push(`events.jsonl: line ${i + 1} hash is not sha256:<64 hex>`);
        else if (typeof e.entity === "string") lastHashByEntity.set(e.entity, e.hash);
      }
    });
  }

  // Content hashes: the entity sidecars are the recorded state; the LAST event
  // per entity kind must hash to exactly them, and run.toml [hashes] (stamped at
  // launch from the same events) must match the last event's hash too.
  for (const kind of ["system", "formulation", "run"]) {
    const file = join(dir, "entities", `${kind}.json`);
    if (!existsSync(file)) continue;
    let entity;
    try {
      entity = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`entities/${kind}.json: not parseable JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const expected = entityHash(entity);
    const last = lastHashByEntity.get(kind);
    if (last === undefined) errors.push(`entities/${kind}.json: no ${kind} event carries a hash — the spine does not cover the recorded entity`);
    else if (last !== expected) errors.push(`events.jsonl: last ${kind} event hash ${last} ≠ sha256 over entities/${kind}.json (${expected}) — content hash broken`);
  }
  if (manifest !== undefined && manifest.hashes !== undefined && typeof manifest.hashes === "object") {
    for (const kind of ["system", "formulation"]) {
      const declared = manifest.hashes[`${kind}_hash`];
      if (declared === undefined) continue;
      const last = lastHashByEntity.get(kind);
      if (typeof declared !== "string" || !SHA256_RE.test(declared)) errors.push(`run.toml: ${kind}_hash is not sha256:<64 hex>`);
      else if (last === undefined) errors.push(`run.toml: ${kind}_hash present but no ${kind} event carries a hash`);
      else if (declared !== last) errors.push(`run.toml: ${kind}_hash ${declared} ≠ the last ${kind} event's hash ${last} — the launch stamps from the spine`);
    }
  }

  // run.log — the stdout contract (the live Inspector's data source; a script
  // that skips these lines gets a dead plot, so a canonical record carries them).
  // Grammar mirrors the extension's run_dir_reader: NUM accepts Julia's %e
  // output plus Inf/NaN (stagnation and blow-up iters stay visible).
  if (!existsSync(join(dir, "run.log"))) errors.push("run.log: missing — the stdout contract is part of the record");
  else {
    const NUM = String.raw`-?(?:Inf|NaN|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)`;
    const ITER_RE = new RegExp(String.raw`^AMICODE_ITER\s+iter=(\d+)\s+f=${NUM}\s+inf_pr=${NUM}\s+inf_du=${NUM}$`);
    const PULSE_RE = new RegExp(String.raw`^AMICODE_PULSE\s+iter=(\d+)\s+dt=${NUM}\s+a=${NUM}(?:,${NUM})*(?:;${NUM}(?:,${NUM})*)$`);
    const lines = readFileSync(join(dir, "run.log"), "utf8").split("\n");
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    const metaIdx = [];
    let firstSignalIdx = -1;
    const iters = [];
    const pulseIters = [];
    lines.forEach((l, i) => {
      if (l.startsWith("AMICODE_PULSE_META")) metaIdx.push(i);
      const m = ITER_RE.exec(l);
      if (m) {
        if (firstSignalIdx === -1) firstSignalIdx = i;
        iters.push(Number(m[1]));
        return;
      }
      const p = PULSE_RE.exec(l);
      if (p) {
        if (firstSignalIdx === -1) firstSignalIdx = i;
        pulseIters.push(Number(p[1]));
        return;
      }
      if (l.startsWith("AMICODE_ITER") || l.startsWith("AMICODE_PULSE ")) {
        if (firstSignalIdx === -1) firstSignalIdx = i;
        errors.push(`run.log: malformed contract line: "${l}" — the grammar is pinned (iter/f/inf_pr/inf_du; iter/dt/a)`);
      }
    });
    if (metaIdx.length === 0) errors.push("run.log: no AMICODE_PULSE_META — the live pulse plot is dead without it");
    if (metaIdx.length > 1) errors.push(`run.log: ${metaIdx.length} AMICODE_PULSE_META lines — it is emitted exactly once, before the solve`);
    if (metaIdx.length === 1 && firstSignalIdx !== -1 && metaIdx[0] > firstSignalIdx) {
      errors.push("run.log: AMICODE_PULSE_META appears after iteration lines — it is emitted once, before the solve");
    }
    if (iters.length === 0) errors.push("run.log: no AMICODE_ITER lines — the stats row has nothing to replay");
    if (pulseIters.length === 0) errors.push("run.log: no AMICODE_PULSE lines — the live plot has no pulse to render");
    for (const [label, arr] of [["AMICODE_ITER", iters], ["AMICODE_PULSE", pulseIters]]) {
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] <= arr[i - 1]) {
          errors.push(`run.log: ${label} iter ${arr[i]} after ${arr[i - 1]} — the streams replay in solve order`);
          break;
        }
      }
    }
    if (lines.length === 0) errors.push("run.log: empty — no DONE line");
    else {
      const done = lines[lines.length - 1];
      if (!/^DONE\s+fidelity=/.test(done)) errors.push(`run.log: last line is not "DONE fidelity=<f>" (got: "${done}")`);
      else if (result !== undefined && typeof result.fidelity === "number") {
        const f = Number(done.slice("DONE fidelity=".length));
        if (!Number.isFinite(f) || Math.abs(f - result.fidelity) > 1e-12) {
          errors.push(`run.log: DONE fidelity=${f} ≠ result.toml fidelity=${result.fidelity} — the number never travels without its pair`);
        }
      }
    }
  }
}

// ─── strumento TaskRecord contract ──────────────────────────────────────────

function validateStrumentoTask(dir, errors) {
  const manifest = readTomlFile("task.toml", dir, errors);
  readTomlFile("result.toml", dir, errors);
  const events = readJsonlFile("progress.jsonl", dir, errors);

  // The manifest: the id IS the directory basename (one identity, not two that
  // can disagree); unknown manifest fields and unknown `kind` axis values are
  // opaque — readers derive and list, never fail (forward compat is contract).
  if (manifest !== undefined) {
    if (typeof manifest.id !== "string" || manifest.id !== basename(resolve(dir))) {
      errors.push("task.toml: id missing or ≠ the directory basename — the id is always the basename");
    }
    if (typeof manifest.created !== "string" || !ISO_RE.test(manifest.created)) {
      errors.push("task.toml: created missing or not ISO-8601");
    }
    if (typeof manifest.kind !== "string" || manifest.kind === "") {
      errors.push("task.toml: kind missing — the kind axis is part of the manifest");
    }
    if (manifest.config_content_id !== undefined && manifest.config_content_id !== "") {
      if (typeof manifest.config_content_id !== "string" || !/^cfg-[0-9a-f]{64}$/.test(manifest.config_content_id)) {
        errors.push("task.toml: config_content_id is not cfg-<sha256> — the calibration provenance is content-addressed");
      }
    }
  }

  // The event stream: known kinds carry their payload shape; unknown `ev`
  // values are carried (skip, never fail). t is ISO-8601 on every line.
  if (events !== undefined) {
    events.forEach((e, i) => {
      const at = `progress.jsonl: line ${i + 1}`;
      if (typeof e.t !== "string" || !ISO_RE.test(e.t)) errors.push(`${at}: t missing or not ISO-8601`);
      if (typeof e.ev !== "string" || e.ev === "") errors.push(`${at}: ev missing — unknown ev VALUES skip, but ev itself is required`);
      else if (e.ev === "artifact") {
        if (typeof e.path !== "string" || e.path === "") errors.push(`${at}: artifact event without a path`);
        else {
          const resolved = resolve(dir, e.path);
          if (e.path.includes("..") || !resolved.startsWith(resolve(dir) + "/")) errors.push(`${at}: artifact path escapes the task dir — recorded paths must resolve inside`);
          else if (!existsSync(resolved)) errors.push(`${at}: artifact path does not resolve to a real file — an artifact event means something was saved`);
        }
      } else if (e.ev === "calibration") {
        if (typeof e.content_id !== "string" || !/^cfg-[0-9a-f]{64}$/.test(e.content_id)) {
          errors.push(`${at}: calibration event content_id is not cfg-<sha256> — the store pointer is content-addressed`);
        }
      } else if (e.ev === "gate") {
        if (typeof e.name !== "string" || e.name === "") errors.push(`${at}: gate event without a name`);
        if (typeof e.pass !== "boolean") errors.push(`${at}: gate event without a boolean pass — a verdict is routed, not prose`);
      } else if (e.ev === "progress") {
        if (e.step !== undefined && (typeof e.step !== "number" || !Number.isInteger(e.step) || e.step < 0)) {
          errors.push(`${at}: progress step is not a non-negative integer`);
        }
        if (e.of !== undefined && (typeof e.of !== "number" || !Number.isInteger(e.of) || e.of < 0)) {
          errors.push(`${at}: progress of is not a non-negative integer`);
        }
      }
    });
  }
}

// ─── the SOTA staging sidecar record (living-sota D3, slice 2) ───────────────
//
// The per-campaign SIDECAR staging stream: append-only transition lines
// (stage/accept/drop/compact) beside the session ledger; state derived by
// replay. The grammar this validator enforces IS the acceptance-stamp schema
// (obligation O3): an accept line carries instructed_by: "PI" + the recorded
// instruction; transitions reference their stage; a stage is unique by event
// id; accept and drop are mutually terminal; unknown `ev` values are carried
// (reader opacity — the fixture ships one on purpose).

const STAGING_KINDS = new Set(["paper", "release", "changelog", "issue"]);

function validateSotaStaging(dir, errors) {
  const manifest = readTomlFile("staging.toml", dir, errors);
  let campaign;
  if (manifest !== undefined) {
    if (manifest.kind !== "sota-staging") {
      errors.push("staging.toml: kind is not sota-staging — the manifest names the record kind");
    }
    if (typeof manifest.campaign !== "string" || manifest.campaign === "") {
      errors.push("staging.toml: campaign missing — the manifest names the sidecar's campaign");
    } else {
      campaign = manifest.campaign;
    }
  }
  // the campaign's own sidecar must be present
  if (campaign !== undefined && !existsSync(join(dir, `${campaign}.sota-staging.jsonl`))) {
    errors.push(`${campaign}.sota-staging.jsonl: missing — the manifest's campaign must have its sidecar`);
  }

  let streams = [];
  try {
    streams = readdirSync(dir).filter((n) => n.endsWith(".sota-staging.jsonl"));
  } catch {
    /* none */
  }
  if (streams.length === 0) {
    errors.push("no *.sota-staging.jsonl stream in the record — a staging record is its streams");
  }
  for (const name of streams) {
    validateStagingStream(dir, name, errors);
  }
}

function validateStagingStream(dir, name, errors) {
  const stem = name.replace(/\.sota-staging\.jsonl$/, "");
  const events = readJsonlFile(name, dir, errors);
  if (events === undefined) return;
  const seenStage = new Set();
  const terminal = new Map(); // event_id → ev ("accept" | "drop")
  events.forEach((e, i) => {
    const at = `${name}: line ${i + 1}`;
    if (e.seq !== i + 1) errors.push(`${at}: seq is ${e.seq} — seq is the line count at write time (monotonic from 1)`);
    if (typeof e.ts !== "string" || !ISO_RE.test(e.ts)) errors.push(`${at}: ts missing or not ISO-8601`);
    const ev = typeof e.ev === "string" ? e.ev : "";
    if (ev === "" || typeof e.event_id !== "string" || e.event_id === "") {
      if (ev !== "") errors.push(`${at}: event_id missing — every transition is keyed by its external identity`);
      else if (typeof e.ev !== "string") errors.push(`${at}: ev missing — unknown ev VALUES skip, but ev itself is required`);
      return;
    }
    if (ev === "stage") {
      if (typeof e.campaign !== "string" || e.campaign !== stem) {
        errors.push(`${at}: campaign "${e.campaign}" ≠ the stream's stem "${stem}" — a sidecar carries its own campaign only`);
      }
      if (!STAGING_KINDS.has(e.kind)) errors.push(`${at}: kind "${e.kind}" outside paper|release|changelog|issue`);
      if (typeof e.title !== "string" || e.title === "") errors.push(`${at}: title missing — the listing renders it`);
      if (typeof e.url !== "string" || e.url === "") errors.push(`${at}: url missing — every staged match is cited`);
      if (e.provenance === null || typeof e.provenance !== "object" || Array.isArray(e.provenance)) {
        errors.push(`${at}: provenance missing — a match never lands unprovenance-stamped`);
      } else {
        for (const k of ["job", "via", "source", "fetched_at"]) {
          if (typeof e.provenance[k] !== "string" || e.provenance[k] === "") {
            errors.push(`${at}: provenance.${k} missing — the stamp carries {job, via, source, fetched_at}`);
          }
        }
      }
      if (typeof e.review_by !== "string" || !ISO_RE.test(e.review_by)) errors.push(`${at}: review_by missing or not ISO-8601 — the review-by stamp is the shape`);
      if (typeof e.expires_at !== "string" || !ISO_RE.test(e.expires_at)) errors.push(`${at}: expires_at missing or not ISO-8601 — the expiry stamp is the shape`);
      if (seenStage.has(e.event_id)) errors.push(`${at}: a second stage for ${e.event_id} — double-delivery is impossible (idempotent by event id)`);
      seenStage.add(e.event_id);
      return;
    }
    if (ev === "accept") {
      // O3: the acceptance-stamp schema — the PI-instructed record
      if (e.instructed_by !== "PI") errors.push(`${at}: instructed_by is not "PI" — the stamp records the human decision, not a job append`);
      if (e.instruction === null || typeof e.instruction !== "object" || Array.isArray(e.instruction)) {
        errors.push(`${at}: instruction missing — an unstamped acceptance is a laundered one`);
      } else {
        if (typeof e.instruction.channel !== "string" || e.instruction.channel === "") errors.push(`${at}: instruction.channel missing`);
        if (typeof e.instruction.note !== "string" || e.instruction.note.trim() === "") errors.push(`${at}: instruction.note missing — the PI's explicit instruction is required`);
        if (typeof e.instruction.received_at !== "string" || !ISO_RE.test(e.instruction.received_at)) errors.push(`${at}: instruction.received_at missing or not ISO-8601`);
      }
    } else if (ev === "drop") {
      if (typeof e.reason !== "string" || e.reason === "") errors.push(`${at}: reason missing — a drop is a recorded line, never a silent skip`);
      if (typeof e.recorded !== "string" || !ISO_RE.test(e.recorded)) errors.push(`${at}: recorded missing or not ISO-8601`);
    }
    // transition grammar: references its stage; accept XOR drop per event id
    if (!seenStage.has(e.event_id)) errors.push(`${at}: ${ev} for ${e.event_id} with no stage behind it — a transition records the fate of a STAGED match`);
    else if (terminal.has(e.event_id)) errors.push(`${at}: ${ev} after ${terminal.get(e.event_id)} for ${e.event_id} — accept and drop are both terminal, exactly one lands`);
    else terminal.set(e.event_id, ev);
  });
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
        `${dir}: no record manifest found (run.toml for an amicode run dir, task.toml for a strumento task dir, staging.toml for a SOTA staging record)`,
      ],
    };
  }
  if (k === "amicode-run") validateAmicodeRun(dir, errors);
  else if (k === "strumento-task") validateStrumentoTask(dir, errors);
  else if (k === "sota-staging") validateSotaStaging(dir, errors);
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
