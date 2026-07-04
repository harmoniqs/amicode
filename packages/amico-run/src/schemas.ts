// Run-dir validators now DELEGATE to the shared @amicode/schema package — the
// single source of truth for the run-dir contract (Phase 0' SchemaPackage). The
// export names and the {ok, errors} shape are preserved so existing consumers
// (the extension's run_dir_reader) are unchanged.
//
// No schema is DEFINED here anymore. Re-introducing a hand-rolled validator /
// schema in this file is a regression (guarded by schemas.test.ts).
import { validate, type Validation } from "@amicode/schema";

export type { Validation };

export function validateManifest(v: unknown): Validation {
  return validate(v, "run");
}

export function validateFinished(v: unknown): Validation {
  return validate(v, "finished");
}

export function validateFormulation(v: unknown): Validation {
  return validate(v, "formulation");
}

export function validateResult(v: unknown): Validation {
  return validate(v, "result");
}
