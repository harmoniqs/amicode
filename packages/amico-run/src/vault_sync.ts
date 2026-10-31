// Sync-sidecar health for `amico vault status` (amicode#2033; amicissimo#357 mechanism M3).
//
// The sync loop (scripts/armonia-sync-once, `write_record`) writes one JSON record per
// git-backed mount; scripts/armonia-vault-status (`state_for`) renders them. This module
// is a READ-ONLY port of that renderer's state model — keep the two in step:
//
//   ZOMBIE        newest(last_success, last_failure) older than 3 × cadence_minutes
//                 (checked FIRST: a dead scheduler must not read as a quiet all-clear)
//   ro-by-policy  failures > 0 AND record.kind == "personal" AND the mount dir is not
//                 writable on disk (expected failure class; muted, no warning)
//   STALE         failures, fetch_blocked, or behind_count > threshold
//   OK            otherwise
//   UNKNOWN       a git-backed mount with no (readable) record
//
// RECORDS LOCATION: `$AMICO_OPS_ROOT/sync-status/` (default `$AMICO_HOME/ops`, i.e.
// `~/.amico/ops`) — what the WRITER uses. This deliberately disagrees with
// `$AMICODE_OPS_DIR` (default `~/.amico/amicode`) used elsewhere in amico-run; that
// disagreement is amicode#1998 and is NOT fixed here.
//
// Never throws: absent/empty/malformed records degrade to UNKNOWN.
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SyncState = "OK" | "STALE" | "UNKNOWN" | "ZOMBIE" | "ro-by-policy";

export interface SyncInfo {
  state: SyncState;
  consecutive_failures: number | null;
  behind_count: number | null;
  fetch_blocked: boolean | null;
  failure_reason: string | null;
  last_success: string | null;
  last_failure: string | null;
  threshold: number | null;
  cadence_minutes: number | null;
}

type SyncRecord = Record<string, unknown>;

export function syncStatusDir(): string {
  const ops = process.env.AMICO_OPS_ROOT;
  if (ops && ops.trim() !== "") return join(ops, "sync-status");
  const home = process.env.AMICO_HOME;
  return join(home && home.trim() !== "" ? home : join(homedir(), ".amico"), "ops", "sync-status");
}

/** Read every `*.json` record, indexed by its recorded `path` and by its filename key
 *  (the writer's resolved-path key). Unreadable/malformed files are skipped. */
export function loadSyncRecords(dir: string = syncStatusDir()): Map<string, SyncRecord> {
  const records = new Map<string, SyncRecord>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return records;
  }
  for (const f of files) {
    try {
      const rec: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const r = rec as SyncRecord;
      records.set(typeof r.path === "string" && r.path ? r.path : f.slice(0, -5), r);
    } catch {
      continue;
    }
  }
  return records;
}

/** A mount is sync-managed only when git-backed (`.git` dir or worktree file). */
export function isGitBacked(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Sync info for one git-backed mount; always returns a state (absence is UNKNOWN). */
export function syncInfoFor(mountPath: string, records: Map<string, SyncRecord>): SyncInfo {
  let real = mountPath;
  try {
    real = realpathSync(mountPath);
  } catch {
    // keep the unresolved path; lookup simply misses
  }
  const rec = records.get(real) ?? records.get(real.replace(/^\/+|\/+$/g, "").replace(/\//g, "_"));
  if (!rec) return blank("UNKNOWN");

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const cadence = num(rec.cadence_minutes) ?? 15;
  const threshold = num(rec.threshold) ?? 50;
  const failures = num(rec.consecutive_failures) ?? 0;
  const behind = num(rec.behind_count);
  const fetchBlocked = rec.fetch_blocked === true;

  const newest = Math.max(parseTs(rec.last_success), parseTs(rec.last_failure));
  let state: SyncState;
  if (newest && Date.now() - newest > 3 * cadence * 60_000) state = "ZOMBIE";
  else if (failures && rec.kind === "personal" && !isWritable(real)) state = "ro-by-policy";
  else if (failures || fetchBlocked || (behind ?? 0) > threshold) state = "STALE";
  else state = "OK";

  return {
    state,
    consecutive_failures: failures,
    behind_count: behind,
    fetch_blocked: fetchBlocked,
    failure_reason: str(rec.failure_reason),
    last_success: str(rec.last_success),
    last_failure: str(rec.last_failure),
    threshold,
    cadence_minutes: cadence,
  };
}

/** The `warnings` entry for a sync state, or undefined when the state is quiet
 *  (OK / ro-by-policy). Leads with the state; carries failures/behind/reason. */
export function syncWarning(s: SyncInfo): string | undefined {
  if (s.state === "OK" || s.state === "ro-by-policy") return undefined;
  if (s.state === "UNKNOWN") return "sync UNKNOWN: no readable sync record (never synced here, or pre-sidecar script version)";
  if (s.state === "ZOMBIE") {
    return `sync ZOMBIE: no sync round recorded within 3× the ${s.cadence_minutes}-minute cadence — the scheduler may be dead (last success: ${s.last_success ?? "never"})`;
  }
  const facts: string[] = [];
  if (s.consecutive_failures) facts.push(`${s.consecutive_failures} consecutive failures`);
  if (s.fetch_blocked) facts.push("fetch blocked");
  if (s.behind_count !== null && (s.behind_count > (s.threshold ?? 50) || s.consecutive_failures)) facts.push(`${s.behind_count} behind`);
  return `sync STALE: ${facts.join(", ")}${s.failure_reason ? ` — ${s.failure_reason}` : ""}`;
}

function blank(state: SyncState): SyncInfo {
  return {
    state,
    consecutive_failures: null,
    behind_count: null,
    fetch_blocked: null,
    failure_reason: null,
    last_success: null,
    last_failure: null,
    threshold: null,
    cadence_minutes: null,
  };
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The writer's timestamp format is `%Y-%m-%dT%H:%M:%S%z` ("+0000"); 0 when unparseable. */
function parseTs(v: unknown): number {
  if (typeof v !== "string") return 0;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(v);
  if (!m) return 0;
  const off = m[2] === "Z" ? "Z" : m[2].length === 5 ? `${m[2].slice(0, 3)}:${m[2].slice(3)}` : m[2];
  const t = Date.parse(m[1] + off);
  return Number.isNaN(t) ? 0 : t;
}
