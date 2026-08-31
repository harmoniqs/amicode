// ============================================================================
// SEAM 1 (amicode #680) — the MockSoc rehearsal artifact reader.
//
// SIBLING-MODULE RULES (same as ./entities, but this one DOES import smol-toml
// — the ./ledger_client precedent: the plugin runs inside opencode's embedded
// Bun runtime, where the package resolves from the extension's node_modules):
// node: builtins + smol-toml only, no other npm packages, never anything from
// ../src/. The pure record type + the outcome gate live in ./entities (which
// IS unit-tested round-trip through smol-toml); this module owns the file →
// record normalization: read rehearsal.toml, parse it, refuse anything that
// is not an honest rehearsal artifact.
//
// THE TRUST CHAIN: the Julia rehearsal script (templates/mocksoc_rehearsal.jl)
// writes rehearsal.toml with `sim = true` pinned. This reader REFUSES an
// artifact that claims otherwise — the sim label is part of the trust chain,
// not a disclaimer the artifact can opt out of. The device session records
// what the rehearsal actually did; a failed rehearsal is recorded distinctly
// and (per rehearsalSatisfiesStage) does NOT satisfy the hardware stage.
// ============================================================================

import * as fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import {
  validateRehearsalRecord,
  type RehearsalRecord,
} from "./entities";

export type ReadRehearsal =
  | { ok: true; record: RehearsalRecord }
  | { ok: false; problem: string };

/** Read + normalize the rehearsal.toml artifact the Julia rehearsal wrote.
 *  Returns `ok: false` with a human-readable problem for anything that is not
 *  an honest rehearsal record — the caller (amicode_to_hardware) relays the
 *  problem and records NOTHING rather than a costume of progress. */
export function readRehearsalRecord(path: string): ReadRehearsal {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      problem: `cannot read the rehearsal artifact at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      problem: `cannot parse the rehearsal artifact at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const table = doc.rehearsal;
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    return { ok: false, problem: `no [rehearsal] table in ${path} — not a rehearsal artifact` };
  }
  const t = table as Record<string, unknown>;
  // The sim label: PINNED true by the script, REFUSED here if not — an artifact
  // claiming sim = false is a contract violation, not a variant.
  if (t.sim !== true) {
    return {
      ok: false,
      problem: `rehearsal artifact at ${path} does not declare sim = true — the sim label is part of the trust chain and cannot be omitted or overridden (got ${JSON.stringify(t.sim)})`,
    };
  }
  const rec: Partial<RehearsalRecord> = {
    kind: t.kind as unknown as RehearsalRecord["kind"],
    outcome: t.outcome as unknown as RehearsalRecord["outcome"],
    pulse_hash: t.pulse_hash as unknown as string,
    mismatch: t.mismatch as unknown as string,
    step_outcome: t.step_outcome as unknown as string | undefined,
    error: t.error as unknown as string | undefined,
    recorded: t.recorded as unknown as string | undefined,
  };
  const problems = validateRehearsalRecord(rec);
  if (problems.length > 0) {
    return { ok: false, problem: `invalid rehearsal artifact at ${path}: ${problems.join("; ")}` };
  }
  return { ok: true, record: rec as RehearsalRecord };
}
