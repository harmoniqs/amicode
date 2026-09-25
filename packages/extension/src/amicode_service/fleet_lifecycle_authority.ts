// EXTENSION-SIDE lifecycle-admin AUTHORITY resolver (#1541, ADR 0034 D3).
//
// The authority store's on-disk contract lives in @amicode/schema (the shared
// home, so `amico fleet enroll` in @amicode/amico-run and this reader agree on
// ONE shape at ONE path — a shared on-disk contract, NOT a cross-package
// import). This module is the extension's typed door onto that resolver: it
// answers "who holds lifecycle-admin authority for machine X" from the service
// side, which #1545's request routing and the self-owned control fast-path
// (`establishManagementVerified`) consume.
//
// A headless target ENFORCES only — the approval act runs on the UI-bearing
// authority machine this resolver names. The resolver is READ-ONLY; the seeding
// writer is the enroll verb.
import {
  resolveLifecycleAuthority as schemaResolve,
  readAllLifecycleAuthorities as schemaReadAll,
  recordLifecycleAuthority as schemaRecord,
  type LifecycleAuthorityRecord,
} from "@amicode/schema";

export type { LifecycleAuthorityRecord };

export interface LifecycleAuthorityResolveDeps {
  /** Override the store file (test/headless seam). Default:
   *  $AMICO_FLEET_LIFECYCLE_AUTHORITY_FILE → ~/.amico/fleet-lifecycle-authority.json. */
  authorityStoreFile?: string;
}

/** Resolve WHO holds lifecycle-admin authority over `targetMachineId`, or
 *  undefined when none is seeded (the honest "no authority yet" — a machine that
 *  never enrolled). */
export function resolveLifecycleAuthority(
  targetMachineId: string,
  deps: LifecycleAuthorityResolveDeps = {},
): LifecycleAuthorityRecord | undefined {
  return schemaResolve(targetMachineId, deps.authorityStoreFile);
}

/** Read ALL seeded authority records (fleet-scale, small set). */
export function readAllLifecycleAuthorities(deps: LifecycleAuthorityResolveDeps = {}): LifecycleAuthorityRecord[] {
  return schemaReadAll(deps.authorityStoreFile);
}

/** SELF-HEAL writer (#1562): persist (upsert) one authority record via the SAME
 *  shared @amicode/schema writer `amico fleet enroll` uses. The extension's
 *  enable-control path invokes this ONLY for a self-owned, serving, token-held
 *  peer whose record is missing — the resolver above then resolves it. */
export function recordLifecycleAuthority(
  record: LifecycleAuthorityRecord,
  deps: LifecycleAuthorityResolveDeps = {},
): void {
  schemaRecord(record, deps.authorityStoreFile);
}
