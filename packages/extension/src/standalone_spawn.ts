// standalone_spawn.ts — Go-Standalone spawn hardening (#781).
//
// The 2026-09-03 incident: the Go-Standalone flow cleared the fleet attach
// poll BEFORE spawning the local server; when the vendored binary crashed on
// a drifted local DB (`duplicate column name: directories`), the window was
// left dead — no poll, no server, no banner — until a reload. The failure
// surfaced as a generic "failed to start within 30s" that hid the cause.
//
// This module is the pure, unit-testable core (the extension.ts wiring stays
// thin): crash-signature detection, the failure notice, the per-window
// re-offer backoff, the poll-lifetime guard, and the journal self-heal
// (the Aug-30 erlich medicine: backup kept, missing journal row inserted).
// All process execution and fs is injected, per the hub_ops/fleet_health
// pattern.

import path from "node:path";
import { opencodeDataDir } from "./opencode_xdg";

// ============================================================================
// AC3 — the known local-DB migration crash signature
// ============================================================================

/** The observed crash mode: a pre-guard vendored binary replays an already-
 *  applied schema migration because the local DB's journal lacks its row, and
 *  SQLite fails with `duplicate column name: <col>` (#776 comment). Matched
 *  from the spawn error output — never from timing or retry counts. */
export function isDbMigrationCrash(message: string): boolean {
  return /duplicate column name/i.test(message);
}

/** The drifted-migration journal row the known medicine inserts. `INSERT OR
 *  IGNORE` keeps the heal idempotent — re-running on a healthy DB is a no-op. */
export const KNOWN_DRIFTED_MIGRATION_IDS = ["20260828201050_normal_stryfe"] as const;

export type SpawnFailureNotice = {
  /** What the user is told (error-message body). */
  title: string;
  /** Button labels, in order. */
  actions: string[];
  /** True when the known DB-migration crash matched — the caller offers the
   *  self-heal behind a CONFIRMATION (it rewrites local session data; never
   *  auto-run). */
  dbCrash: boolean;
  /** The action label that triggers the self-heal flow (present only when dbCrash). */
  healAction?: string;
};

export const SELF_HEAL_ACTION = "Self-heal local DB…";
export const SHOW_LOG_ACTION = "Show log";

/** Build the failure notice. DB-crash failures surface the ACTUAL cause with
 *  the remediation offered inline; everything else keeps the existing
 *  generic error path. */
export function spawnFailureNotice(message: string, spawnOutput?: string): SpawnFailureNotice {
  const combined = `${message}\n${spawnOutput ?? ""}`;
  if (isDbMigrationCrash(combined)) {
    return {
      dbCrash: true,
      healAction: SELF_HEAL_ACTION,
      title:
        "Amicode: go standalone failed — the local session DB failed a schema migration " +
        "(“duplicate column name”). This is a known journal drift; the journal self-heal can repair it. " +
        "A backup of the DB is kept before anything is written.",
      actions: [SELF_HEAL_ACTION, SHOW_LOG_ACTION],
    };
  }
  return {
    dbCrash: false,
    title: `Amicode: go standalone failed — ${message}`,
    actions: [SHOW_LOG_ACTION],
  };
}

/** The client's local session DB (the same file the vendored server opens). */
export function localDbPath(): string {
  return path.join(opencodeDataDir(), "opencode.db");
}

// ============================================================================
// AC2 — per-window re-offer backoff (replaces the one-shot `fleetNotified`)
// ============================================================================

/** Delay before the FIRST re-offer after one has fired. The initial offer
 *  itself is still gated by the attach loop's warm-up (5 checks ≈ 10s). */
export const REOFFER_BASE_MS = 30_000;
/** Dev's call (#781 leaves the ceiling open): 5 minutes — often enough to
 *  stay discoverable while the hub is down, quiet enough not to nag. The old
 *  "offer once per window lifetime" behavior is gone: the backoff resets on
 *  any successful attach. */
export const REOFFER_CEILING_MS = 300_000;

export class ReofferBackoff {
  private lastOffer: number | undefined;
  private offers = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseMs: number = REOFFER_BASE_MS,
    private readonly ceilingMs: number = REOFFER_CEILING_MS,
  ) {}

  /** True when an offer may fire now: never offered, or the current backoff
   *  delay has elapsed since the last one. */
  due(): boolean {
    if (this.lastOffer === undefined) return true;
    return this.now() - this.lastOffer >= this.delayMs();
  }

  recordOffer(): void {
    this.lastOffer = this.now();
    this.offers++;
  }

  /** Any successful attach resets the schedule (AC2). */
  reset(): void {
    this.lastOffer = undefined;
    this.offers = 0;
  }

  private delayMs(): number {
    // After offer N (N≥1), the next is due after base × 2^(N-1), capped.
    return Math.min(this.baseMs * 2 ** (this.offers - 1), this.ceilingMs);
  }
}

/** One offer outstanding at a time — `showWarningMessage` is non-modal and
 *  stacking banners is exactly the "double banner" #781 bans (AC4). */
export class OfferGate {
  private pending = false;
  tryBegin(): boolean {
    if (this.pending) return false;
    this.pending = true;
    return true;
  }
  end(): void {
    this.pending = false;
  }
}

// ============================================================================
// AC1 + AC4 — the attach poll outlives the spawn attempt
// ============================================================================

/** Poll-lifetime guard for the Go-Standalone spawn. The poll is NEVER stopped
 *  before the spawn; it stops only once the local server is healthy (exactly
 *  once), and every failure path resumes it. */
export class FleetPollGuard {
  private stopped = false;

  constructor(private readonly hooks: { stopPoll: () => void; resumePoll: () => void }) {}

  /** The local server reported healthy — the attach poll has no job left.
   *  Idempotent: a second healthy report must not double-stop (AC4). */
  onLocalHealthy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hooks.stopPoll();
  }

  /** The spawn failed — the window must keep an active attach poll (AC1).
   *  Always resumes, even after a prior successful stop (the user may be
   *  re-attaching after standalone mode). */
  onSpawnFailure(): void {
    this.stopped = false;
    this.hooks.resumePoll();
  }
}

// ============================================================================
// AC3 — the journal self-heal (the Aug-30 erlich medicine)
// ============================================================================

export type HealStep = { step: "backup" | "verify" | "insert"; ok: boolean; detail: string };
export type HealRunner = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type HealDeps = {
  /** The client's local session DB. */
  dbPath: string;
  /** Process runner (sqlite3). Injected — the decision logic stays testable. */
  run: HealRunner;
  /** fs surface for the backup. Injected. */
  fs: { existsSync(p: string): boolean; copyFileSync(src: string, dest: string): void };
  /** Journal rows to repair. Defaults to the known drifted migration. */
  migrationIds?: readonly string[];
  now?: () => number;
};

export type HealResult = { ok: boolean; steps: HealStep[] };

const BACKUP_KEEP = "A backup was kept alongside the DB (.bak-<timestamp>).";

/** The self-heal: back up the DB, verify the drift is what it looks like
 *  (the migration's work IS in the schema — only the journal row is missing),
 *  then insert the missing journal row(s). Honest at every step; refuses to
 *  fake a journal row the schema doesn't corroborate. The CALLER owns the
 *  user confirmation — this function is never invoked without one. */
export async function journalSelfHeal(deps: HealDeps): Promise<HealResult> {
  const steps: HealStep[] = [];
  const now = deps.now ?? Date.now;
  const ids = deps.migrationIds ?? KNOWN_DRIFTED_MIGRATION_IDS;

  // 1. Backup — never rewrite session data without a copy kept first.
  if (!deps.fs.existsSync(deps.dbPath)) {
    steps.push({ step: "backup", ok: false, detail: `local DB not found at ${deps.dbPath} — nothing was changed` });
    return { ok: false, steps };
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${deps.dbPath}.bak-${stamp}`;
  try {
    deps.fs.copyFileSync(deps.dbPath, backupPath);
    steps.push({ step: "backup", ok: true, detail: `copied to ${backupPath}` });
  } catch (e) {
    steps.push({ step: "backup", ok: false, detail: `backup failed: ${e instanceof Error ? e.message : String(e)} — nothing was changed` });
    return { ok: false, steps };
  }

  // 2. Verify — the journal table exists, and the schema actually shows the
  //    migration's work applied (a `directories` column exists somewhere).
  //    If the schema does NOT show it, inserting the row would mask a real
  //    half-applied migration — refuse.
  const verifyCmd = [
    "sqlite3",
    deps.dbPath,
    "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='migration'), " +
      "(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND sql LIKE '%directories%');",
  ];
  const verify = await deps.run(verifyCmd);
  if (verify.code !== 0) {
    steps.push({ step: "verify", ok: false, detail: `sqlite3 failed: ${verify.stderr.trim() || `exit ${verify.code}`}. ${BACKUP_KEEP}` });
    return { ok: false, steps };
  }
  const [journalTables, appliedEvidence] = verify.stdout.trim().split("|").map((n) => Number.parseInt(n, 10));
  if (journalTables !== 1) {
    steps.push({ step: "verify", ok: false, detail: `local journal table 'migration' not found in ${deps.dbPath} — unexpected DB shape; nothing was changed. ${BACKUP_KEEP}` });
    return { ok: false, steps };
  }
  if (!appliedEvidence) {
    steps.push({ step: "verify", ok: false, detail: "the schema does not show the migration's work applied — refusing to mark it applied (the DB may be half-migrated). Nothing was changed. " + BACKUP_KEEP });
    return { ok: false, steps };
  }
  steps.push({ step: "verify", ok: true, detail: "journal table present; schema shows the migration applied — drift confirmed as a missing journal row" });

  // 3. Insert the missing journal row(s). INSERT OR IGNORE → idempotent.
  for (const id of ids) {
    const insert = await deps.run([
      "sqlite3",
      deps.dbPath,
      `INSERT OR IGNORE INTO migration (id, time_completed) VALUES ('${id}', ${now()});`,
    ]);
    steps.push({
      step: "insert",
      ok: insert.code === 0,
      detail:
        insert.code === 0
          ? `journal row '${id}' present`
          : `insert failed: ${insert.stderr.trim() || `exit ${insert.code}`}. ${BACKUP_KEEP}`,
    });
    if (insert.code !== 0) return { ok: false, steps };
  }
  return { ok: true, steps };
}

// ============================================================================
// The orchestration the extension.ts wiring delegates to — poll lifetime,
// failure notice, and the confirmation-gated self-heal in one testable unit.
// ============================================================================

export type StandaloneSpawnDeps = {
  /** Attach-poll hooks (FleetPollGuard): stop only after health; restore on failure. */
  poll: { stopPoll: () => void; resumePoll: () => void };
  /** Builds + starts the standalone ServerManager. Resolves = local server healthy. */
  startServer: () => Promise<unknown>;
  /** Shows the failure prompt; returns the chosen action label (undefined = dismissed). */
  notice: (notice: SpawnFailureNotice) => Promise<string | undefined>;
  /** The self-heal's confirmation gate — the heal NEVER runs without it. */
  confirmHeal: (notice: SpawnFailureNotice) => Promise<boolean>;
  /** The journal self-heal itself (caller binds real fs/sqlite3 deps). */
  heal: () => Promise<HealResult>;
  /** Surfacing for the heal outcome (toast + output channel on the caller side). */
  onHealResult: (result: HealResult) => void;
  log?: (line: string) => void;
};

export type StandaloneSpawnResult = {
  ok: boolean;
  notice?: SpawnFailureNotice;
  healConfirmed?: boolean;
  heal?: HealResult;
};

/** Run the Go-Standalone spawn with #781's hardening: the attach poll is NOT
 *  stopped before the spawn (it stops exactly once the local server is
 *  healthy, AC1+AC4); a failed spawn always restores the poll (AC1) and
 *  surfaces the actual cause — the known DB-migration crash gets the journal
 *  self-heal offered inline, strictly behind a user confirmation (AC3). */
export async function goStandaloneSpawn(deps: StandaloneSpawnDeps): Promise<StandaloneSpawnResult> {
  const guard = new FleetPollGuard(deps.poll);
  try {
    await deps.startServer();
    guard.onLocalHealthy();
    return { ok: true };
  } catch (e) {
    guard.onSpawnFailure();
    const err = e as Error & { spawnOutput?: string };
    const notice = spawnFailureNotice(err.message ?? String(e), err.spawnOutput);
    deps.log?.(
      `[fleet] go standalone failed: ${notice.dbCrash ? "local-DB migration crash (duplicate column name)" : (err.message ?? String(e))}`,
    );
    const pick = await deps.notice(notice);
    if (notice.dbCrash && notice.healAction !== undefined && pick === notice.healAction) {
      const confirmed = await deps.confirmHeal(notice);
      if (!confirmed) {
        deps.log?.("[fleet] journal self-heal declined — nothing was changed");
        return { ok: false, notice, healConfirmed: false };
      }
      deps.log?.("[fleet] journal self-heal confirmed — running (backup kept first)");
      const heal = await deps.heal();
      deps.onHealResult(heal);
      return { ok: false, notice, healConfirmed: true, heal };
    }
    return { ok: false, notice };
  }
}
