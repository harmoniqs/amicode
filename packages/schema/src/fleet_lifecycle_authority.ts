// The lifecycle-admin AUTHORITY store (amicode#1541, ADR 0034 D3) — the NET-NEW
// persistence that seeds "who holds lifecycle-admin authority over machine X" at
// `amico fleet enroll`. Before this, `authorityIdentityKey` existed ONLY as an
// injected parameter to the pure `isLifecycleAuthority` predicate — no store, no
// writer, no resolver. This module is that store's on-disk contract.
//
// It lives in @amicode/schema, the repo's home for cross-package shared
// contracts, for the SAME reason fleet_roster.ts and fleet_config.ts do: the
// WRITER is `amico fleet enroll` (in @amicode/amico-run, which cannot import the
// extension), and the RESOLVER is consumed extension-side (#1545 request
// routing). They agree on ONE on-disk shape at ONE path — a shared on-disk
// contract, never a cross-package import.
//
// On-disk file: ~/.amico/fleet-lifecycle-authority.json (0600), keyed by the
// TARGET machine_id (the machine whose authority this row describes):
//   { "store_version": 1,
//     "authorities": {
//       "<target_machine_id>": { authority_machine_id, authority_identity_key, recorded_at } } }
//
// `lifecycle-admin` authority is NOT a superset of `control` (ADR 0034): it
// names WHO may mint/revoke/re-admit for a machine — the approval act runs on a
// UI-bearing authority machine; a headless target only enforces. This store is
// what makes a headless peer approvable from elsewhere.
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

/** The authority store's schema version — bumped independently of the roster /
 *  projection / grant contracts (a distinct, amicode-owned artifact). */
export const LIFECYCLE_AUTHORITY_STORE_VERSION = 1;

const AUTHORITIES_COLLECTION = "authorities";

/** One authority record: machine `targetMachineId`'s lifecycle-admin authority
 *  is `authorityMachineId` (identified by `authorityIdentityKey`). Recorded at
 *  Enroll on the machine that ran it. */
export interface LifecycleAuthorityRecord {
  /** The machine whose authority this row describes (the store key). */
  targetMachineId: string;
  /** The machine that holds lifecycle-admin authority over the target (the
   *  enroller / canonical server in the self-owned server-first flow). */
  authorityMachineId: string;
  /** The authority's stable identity anchor — the value `isLifecycleAuthority`
   *  compares a presented `identityKey` against. */
  authorityIdentityKey: string;
  /** ISO stamp of when the authority was seeded. */
  recordedAt: string;
}

/** The authority store path. `$AMICO_FLEET_LIFECYCLE_AUTHORITY_FILE` overrides
 *  (test/headless seam), else `~/.amico/fleet-lifecycle-authority.json`. */
export function lifecycleAuthorityStorePath(home: string = homedir()): string {
  const env = process.env.AMICO_FLEET_LIFECYCLE_AUTHORITY_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(home, ".amico", "fleet-lifecycle-authority.json");
}

interface AuthorityDoc {
  store_version?: number;
  [key: string]: unknown;
}

interface StoredAuthorityRecord {
  authority_machine_id: string;
  authority_identity_key: string;
  recorded_at: string;
}

/** Tolerant whole-file read — an absent/corrupt/non-object file is {} (never a
 *  throw), so a resolver degrades to "no authority" rather than crashing. */
function readDoc(file: string): AuthorityDoc {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as AuthorityDoc;
}

function collectionOf(doc: AuthorityDoc): Record<string, unknown> {
  const c = doc[AUTHORITIES_COLLECTION];
  return typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

function parseStored(targetMachineId: string, raw: unknown): LifecycleAuthorityRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const authorityMachineId = typeof r.authority_machine_id === "string" ? r.authority_machine_id : "";
  const authorityIdentityKey = typeof r.authority_identity_key === "string" ? r.authority_identity_key : "";
  const recordedAt = typeof r.recorded_at === "string" ? r.recorded_at : "";
  if (authorityMachineId === "" || authorityIdentityKey === "") return undefined;
  return { targetMachineId, authorityMachineId, authorityIdentityKey, recordedAt };
}

/** Persist (upsert) one authority record atomically, 0600, keyed by the target
 *  machine_id. Every OTHER entry and unknown top-level key is preserved. This is
 *  the writer `amico fleet enroll` invokes (its default enroll seam). */
export function recordLifecycleAuthority(
  record: LifecycleAuthorityRecord,
  p: string = lifecycleAuthorityStorePath(),
): void {
  const doc = readDoc(p);
  const stored: StoredAuthorityRecord = {
    authority_machine_id: record.authorityMachineId,
    authority_identity_key: record.authorityIdentityKey,
    recorded_at: record.recordedAt,
  };
  const collection = { ...collectionOf(doc), [record.targetMachineId]: stored };
  const out: AuthorityDoc = {
    ...doc,
    store_version: LIFECYCLE_AUTHORITY_STORE_VERSION,
    [AUTHORITIES_COLLECTION]: collection,
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // best-effort — the rename landed; a chmod race is not fatal.
  }
}

/** Resolve WHO holds lifecycle-admin authority for a machine, or undefined. The
 *  read #1545's request routing consumes; the read the enroll writer's output is
 *  verified against. */
export function resolveLifecycleAuthority(
  targetMachineId: string,
  p: string = lifecycleAuthorityStorePath(),
): LifecycleAuthorityRecord | undefined {
  return parseStored(targetMachineId, collectionOf(readDoc(p))[targetMachineId]);
}

/** Read ALL authority records (fleet-scale, small set). */
export function readAllLifecycleAuthorities(p: string = lifecycleAuthorityStorePath()): LifecycleAuthorityRecord[] {
  const collection = collectionOf(readDoc(p));
  const out: LifecycleAuthorityRecord[] = [];
  for (const [target, raw] of Object.entries(collection)) {
    const rec = parseStored(target, raw);
    if (rec) out.push(rec);
  }
  return out;
}
