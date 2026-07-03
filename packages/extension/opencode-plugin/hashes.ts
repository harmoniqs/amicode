// ============================================================================
// SHA-256 hashing for the amicode_* tool pack (spec A / amicode#64).
//
// SIBLING-MODULE RULES (same as ./score_guard): imported by amicode_tools.ts
// inside opencode's Bun runtime via a relative `./hashes` import — node: builtins
// only, named exports fine (the single-export constraint is the plugin entry's,
// not this file's). Its logic is pure and unit-tested from test/hashes.test.ts.
//
// This file is DELIBERATELY separate from ./entities: entities.ts is
// dependency-free / dual-runtime (no node: builtins, so no `node:crypto`), so the
// hash lives here and consumes entities.ts's pure `canonicalJson`. `system_hash`
// / `formulation_hash` (amicode#64's System ÷ Formulation identity cut) are
// `entityHash(entity)` over the canonical serialization.
// ============================================================================

import { createHash } from "node:crypto";
import { canonicalJson } from "./entities";

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Content hash of an entity over its canonical JSON (key-sorted, recorded/notes
 *  excluded). Prefixed `sha256:` for self-describing storage in events/run.toml. */
export function entityHash(entity: unknown): string {
  return "sha256:" + sha256Hex(canonicalJson(entity));
}
