// ============================================================================
// SEAM 5 (amicode #681) — the calibrate→pin→re-optimize→re-bank chain, the
// recording core behind the `amicode_calib_chain` tool.
//
// SIBLING-MODULE RULES (same as ./rehearsal — this one DOES import smol-toml,
// the ./rehearsal + ./ledger_client precedent: the plugin runs inside
// opencode's embedded Bun runtime, where the package resolves from the
// extension's node_modules): node: builtins + smol-toml only, no other npm
// packages, never anything from ../src/.
//
// The chain composes EXISTING seams — no new physics, no new tiers; the
// RECORDING PATH is the deliverable (spec SEAM 5):
//   1. calibrate — mock leg: the SEAM 1 rehearsal artifact is the calibration
//      data source (read through ./rehearsal — the SAME reader the tool uses;
//      a dishonest artifact records NOTHING). Hardware leg: structurally
//      refused — real-board sessions are an enumerated human gate, and this
//      build has no real-board session surface. `hardwareLegRefusal` is the
//      tested refusal path, mirroring the human-gates enumeration.
//   2. pin — the calibrated globals land on the EXISTING formulation surfaces:
//      the `calibration_pin` constraint (params = the values; re-staging
//      replaces it — a pin is a set point, not an accumulating list) and
//      `solve.pinned_globals` (the names) — the fix_global_variable! path.
//   3. re-optimize — the run stub records the warm-start seed (additive
//      `warm_start`); the re-solve itself launches through the EXISTING solve
//      path (bash amico-run) — this core NEVER launches anything.
//   4. re-bank — the chain stages the `amico catalog ingest` command with the
//      provenance flags (which calibration, which pin, which seed) and
//      VERIFIES the promoted entry afterwards. Promotion is human-gated like
//      all promotions: this core performs NO catalog write (read-only verify);
//      the ingest runs out-of-band, only on the researcher's sign-off.
//
// The executed marker: `completeCalibChain` verifies the promoted entry's
// catalog note carries THIS chain's fingerprint, then appends the
// `executed_on_mock` event — the countable execution record
// (`calib_pin_reopt_chain_executed_on_mock == 1` is an event, not a schema).
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  calibChainToml,
  entityDiff,
  normalizeFormulation,
  normalizeSystem,
  runStubToml,
  updateFormulation,
  formulationToml,
  validateCalibChainRecord,
  type CalibChainRecord,
  type Constraint,
  type FormulationEntity,
  type RunStub,
} from "./entities";
import { entityHash } from "./hashes";
import { appendEvent, problemDir, writeEntityFiles } from "./problems";
import { readRehearsalRecord } from "./rehearsal";

/** The chain's calibration leg. Only "mock" is constructible; "hardware" is
 *  refused by the recording path (see hardwareLegRefusal). */
export type ChainLeg = "mock" | "hardware";

/** The hardware-leg refusal — names the enumerated human gate. Real-board
 *  sessions are one of the five enumerated human gates the premium tier may
 *  never route around; this build has no real-board session surface, so the
 *  hardware calibration leg is structurally impossible and the chain says so
 *  instead of recording a costume of it. */
export function hardwareLegRefusal(): string {
  return (
    "the hardware calibration leg runs ONLY inside a real-board session — one of the " +
    "enumerated human gates (live gateway spend; real-board sessions; opening P4 on real " +
    "hardware; defaults-flips with live behavior; promotions of results) — and this build " +
    "has no real-board session surface. The chain's calibration leg is the SEAM 1 MockSoc " +
    "rehearsal (mock), and that is all it can honestly record. Nothing was recorded."
  );
}

export interface RecordCalibChainInput {
  /** The problem workspace slug (the tool resolves the active problem). */
  slug: string;
  leg: ChainLeg;
  /** Path to the rehearsal.toml artifact — the mock leg's calibration data
   *  source (SEAM 1). Validated through the same reader the tool uses. */
  rehearsalRef: string;
  /** The calibrated globals to pin (global → value). */
  pinned: Record<string, number>;
  /** The bank seed the re-solve warm-starts from (catalog entry id or pulse ref). */
  warmStart: string;
  /** The re-solve's run directory, once launched (optional at stage time). */
  runDir?: string;
  note?: string;
}

export interface StagedChain {
  /** The exact `amico catalog ingest` command carrying the chain's provenance —
   *  the promotion the chain never performs (human-gated like all promotions). */
  rebankCommand: string;
  /** The human-gate instruction to relay with the command. */
  humanGate: string;
  /** The chain entity's TOML ref (its recorded fingerprint). */
  chainRef: string;
  /** The chain entity's event receipt (the wrapper renders the AMICODE_DIFF
   *  sentinel from it — same idiom as every entity write in the tool pack). */
  chainEvent: { action: "created" | "updated"; seq: number; diff: Record<string, { from: unknown; to: unknown }> };
}

export type RecordCalibChainResult =
  | { ok: true; staged: StagedChain }
  | { ok: false; problem: string };

export interface CompleteCalibChainInput {
  slug: string;
  /** Path to the promoted catalog entry's metadata.toml — read (never written)
   *  to verify the re-bank carries this chain's fingerprint. */
  rebankMetadataRef: string;
}

export type CompleteCalibChainResult =
  | { ok: true; executed_on_mock: boolean; already?: boolean; chainEvent: { action: "created" | "updated"; seq: number; diff: Record<string, { from: unknown; to: unknown }> } }
  | { ok: false; problem: string };

/** Read an entity's JSON sidecar (the plugin is TOML-writer-only; reads go
 *  through .json). */
function readEntityJson<T>(slug: string, kind: string): T | undefined {
  const file = path.join(problemDir(slug), "entities", `${kind}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Persist an entity: write TOML+JSON sidecar, append a structured-diff event
 *  with content hash. The parallel of amicode_tools.ts's recordEntity (this
 *  module cannot import from the plugin entry — single-export constraint). */
function recordEntity(
  slug: string,
  kind: string,
  entity: Record<string, unknown>,
  toml: string,
  source: { tool: string; stage?: string },
): { action: "created" | "updated"; seq: number; diff: Record<string, { from: unknown; to: unknown }> } {
  const before = readEntityJson<Record<string, unknown>>(slug, kind);
  const action: "created" | "updated" = before ? "updated" : "created";
  writeEntityFiles(slug, kind, toml, JSON.stringify(entity, null, 2) + "\n");
  const diff = entityDiff(before, entity);
  const seq = appendEvent(slug, { entity: kind, action, diff, hash: entityHash(entity), source });
  return { action, seq, diff };
}

/** The staged re-bank command — the chain's provenance flags riding `amico
 *  catalog ingest` (which calibration, which pin, which warm-start seed). */
function rebankCommand(
  form: FormulationEntity,
  platform: string,
  chain: CalibChainRecord,
  chainRef: string,
): string {
  const pin = Object.entries(chain.pinned_globals)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const runSrc = chain.run_dir !== undefined ? `--from-run ${chain.run_dir}` : "--from-run <run-dir-of-the-re-solve>";
  return (
    `amico catalog ingest --platform ${platform} --kind ${form.target} ${runSrc} ` +
    `--warm-start ${chain.warm_start} --calibration-ref ${chain.calibration.source} ` +
    `--pin ${pin}`
  );
}

const HUMAN_GATE_NOTE =
  "promotion is human-gated like all promotions — run the staged ingest only after the " +
  "researcher signs off (and only with verification evidence: --agree true or a run dir " +
  "with verification.toml); the chain records the outcome, it never promotes.";

/** Stage the chain's calibrate + pin + re-optimize legs. Refusals record
 *  NOTHING (honest refusal, never a costume of progress). */
export function recordCalibChain(input: RecordCalibChainInput): RecordCalibChainResult {
  // leg 1 — calibrate. The hardware leg is structurally refused.
  if (input.leg !== "mock") return { ok: false, problem: hardwareLegRefusal() };

  const rr = readRehearsalRecord(input.rehearsalRef);
  if (!rr.ok) {
    return {
      ok: false,
      problem: `the calibration artifact is not an honest rehearsal record — ${rr.problem}. Nothing was recorded.`,
    };
  }

  const pinEntries = Object.entries(input.pinned ?? {});
  if (pinEntries.length === 0) {
    return { ok: false, problem: "the chain pins at least one calibrated global — pass a non-empty `pinned` set. Nothing was recorded." };
  }
  if (typeof input.warmStart !== "string" || input.warmStart.trim() === "") {
    return { ok: false, problem: "warm_start (the bank seed) is required — the re-optimize leg warm-starts from the bank. Nothing was recorded." };
  }

  // leg 2 — pin: onto the RECORDED formulation (existing surfaces only).
  const formRaw = readEntityJson<Record<string, unknown>>(input.slug, "formulation");
  if (!formRaw) {
    return {
      ok: false,
      problem: "no formulation recorded in this problem — the chain pins the calibrated globals onto the recorded formulation (the calibration_pin constraint). Nothing was recorded.",
    };
  }
  const form = normalizeFormulation(formRaw);
  const prior = form.constraints.filter((c) => c.kind !== "calibration_pin");
  const pinConstraint: Constraint = {
    kind: "calibration_pin",
    params: { ...input.pinned },
    label: `calibrate→pin chain: ${rr.record.mismatch}`,
  };
  const mergedForm = updateFormulation(formRaw, {
    constraints: [...prior, pinConstraint],
    solve: { pinned_globals: pinEntries.map(([k]) => k) },
  });

  // leg 3 — re-optimize: the run stub records the warm-start seed.
  const dir = problemDir(input.slug);
  const sysPath = path.join(dir, "entities", "system.toml");
  const formPath = path.join(dir, "entities", "formulation.toml");
  const existingRun = readEntityJson<RunStub>(input.slug, "run") ?? ({} as RunStub);
  const runStub: RunStub = {
    ...existingRun,
    ...(fs.existsSync(sysPath) ? { system_ref: sysPath } : {}),
    ...(fs.existsSync(formPath) ? { formulation_ref: formPath } : {}),
    warm_start: input.warmStart,
    ...(input.runDir !== undefined ? { run_dir: input.runDir } : {}),
  };

  // the chain entity — the fingerprint.
  const chain: CalibChainRecord = {
    leg: "mock",
    calibration: {
      source: input.rehearsalRef,
      pulse_hash: rr.record.pulse_hash,
      mismatch: rr.record.mismatch,
    },
    pinned_globals: { ...input.pinned },
    warm_start: input.warmStart,
    ...(input.runDir !== undefined ? { run_dir: input.runDir } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  const chainProblems = validateCalibChainRecord(chain);
  if (chainProblems.length > 0) {
    return { ok: false, problem: `invalid chain record: ${chainProblems.join("; ")}. Nothing was recorded.` };
  }

  const sysRaw = readEntityJson<Record<string, unknown>>(input.slug, "system");
  const platform = sysRaw ? normalizeSystem(sysRaw).platform : "<platform>";

  // Write through the existing entities + the chain — the provenance spine.
  recordEntity(input.slug, "formulation", mergedForm as unknown as Record<string, unknown>, formulationToml(mergedForm), {
    tool: "amicode_calib_chain",
    stage: "formulate",
  });
  recordEntity(input.slug, "run", runStub as unknown as Record<string, unknown>, runStubToml(runStub), {
    tool: "amicode_calib_chain",
    stage: "solve",
  });
  const chainRef = path.join(dir, "entities", "calib_chain.toml");
  const chainEvent = recordEntity(
    input.slug,
    "calib_chain",
    chain as unknown as Record<string, unknown>,
    calibChainToml(chain),
    { tool: "amicode_calib_chain" },
  );

  return {
    ok: true,
    staged: {
      rebankCommand: rebankCommand(mergedForm, platform, chain, chainRef),
      humanGate: HUMAN_GATE_NOTE,
      chainRef,
      chainEvent: { action: chainEvent.action, seq: chainEvent.seq, diff: chainEvent.diff },
    },
  };
}

/** Read the promoted entry's catalog note (smol-toml parse; never written). */
function readCatalogMetadata(ref: string): Record<string, unknown> | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(ref, "utf8");
  } catch (err) {
    return { error: `cannot read the promoted entry's metadata at ${ref}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    return { error: `cannot parse the promoted entry's metadata at ${ref}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function samePin(a: unknown, b: Record<string, number>): boolean {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return false;
  const ao = a as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return bk.every((k) => typeof ao[k] === "number" && Number.isFinite(ao[k]) && ao[k] === b[k]);
}

/** Complete the chain: verify the promoted entry's catalog note carries THIS
 *  chain's fingerprint (which calibration, which pin, which seed), then land
 *  the re-bank leg + the `executed_on_mock` event — the countable execution
 *  record. The promotion itself happened out-of-band (the human-gated ingest);
 *  this core only READS the result. Idempotent: completing an already-completed
 *  chain re-verifies and never appends a second executed event. */
export function completeCalibChain(input: CompleteCalibChainInput): CompleteCalibChainResult {
  const chain = readEntityJson<CalibChainRecord>(input.slug, "calib_chain");
  if (!chain) {
    return {
      ok: false,
      problem: "no chain staged in this problem — stage the calibrate→pin→re-optimize legs first (amicode_calib_chain with the rehearsal artifact + pin + seed). Nothing was recorded.",
    };
  }

  const meta = readCatalogMetadata(input.rebankMetadataRef);
  if ("error" in meta) {
    return {
      ok: false,
      problem: `${meta.error}. ${HUMAN_GATE_NOTE}`,
    };
  }

  // the fingerprint check — the re-bank must carry THIS chain's provenance.
  const mismatches: string[] = [];
  if (meta.warm_start !== chain.warm_start) {
    mismatches.push(`warm_start: note has ${JSON.stringify(meta.warm_start)}, chain pinned ${JSON.stringify(chain.warm_start)}`);
  }
  if (meta.calibration_ref !== chain.calibration.source) {
    mismatches.push(`calibration_ref: note has ${JSON.stringify(meta.calibration_ref)}, chain ran ${JSON.stringify(chain.calibration.source)}`);
  }
  if (!samePin(meta.pinned_globals, chain.pinned_globals)) {
    mismatches.push(`pinned_globals: note has ${JSON.stringify(meta.pinned_globals ?? null)}, chain pinned ${JSON.stringify(chain.pinned_globals)}`);
  }
  const entryId = typeof meta.id === "string" ? meta.id : "";
  if (entryId.trim() === "") {
    mismatches.push("id: the promoted entry's metadata carries no entry id");
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      problem: `the re-bank does not carry this chain's provenance — ${mismatches.join("; ")}. Re-run the staged ingest with the chain's provenance flags. Nothing was recorded.`,
    };
  }

  const provenance = {
    warm_start: chain.warm_start,
    calibration_ref: chain.calibration.source,
    pinned_globals: { ...chain.pinned_globals },
  };
  const already =
    chain.rebank !== undefined && chain.rebank.catalog_entry === entryId && chain.rebank.provenance.warm_start === provenance.warm_start;
  const completed: CalibChainRecord = { ...chain, rebank: { catalog_entry: entryId, provenance } };

  const chainEvent = recordEntity(
    input.slug,
    "calib_chain",
    completed as unknown as Record<string, unknown>,
    calibChainToml(completed),
    { tool: "amicode_calib_chain" },
  );
  if (!already) {
    // THE EXECUTION RECORD — countable in events.jsonl
    // (`calib_pin_reopt_chain_executed_on_mock == 1` is this event).
    appendEvent(input.slug, {
      entity: "calib_chain",
      action: "executed_on_mock",
      diff: { rebank: { from: chain.rebank ? "present" : null, to: entryId } },
      hash: entityHash(completed),
      source: { tool: "amicode_calib_chain" },
    });
  }
  return {
    ok: true,
    executed_on_mock: true,
    ...(already ? { already: true } : {}),
    chainEvent: { action: chainEvent.action, seq: chainEvent.seq, diff: chainEvent.diff },
  };
}
