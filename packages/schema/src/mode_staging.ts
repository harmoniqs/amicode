// mode_staging.ts — the atomic mode-bundle stager (#804, spec-20260905-063000
// D1, H2): stages every director-mode bundle (card, pack, roles,
// handoff-seed schemas, manifest) into <destRoot>/modes/<mode>/ as ONE
// locked, receipt-audited unit. Legacy card staging (mode_cards.ts) remains
// AUTHORITATIVE — this module never touches the legacy agents destination;
// the source flip lands with the role-cards slice (D3).
//
// Staging semantics (reconciled with the #761/#614 entitlement staging gate,
// recorded as the pre-flight outcome of #804): ALWAYS-COPY base artifacts,
// extension-owned, overwrite-on-stage, never blocks activation; entitlement
// never enters bundle staging (bundles are public data); idempotence is
// source-minus-generated artifact bytes unchanged — receipt freshness and
// generator stamps excepted; a validation failure is loud, never a silent
// skip; overlay-style precedence has no analogue here and none is invented.
//
// ATOMICITY — the precise guarantee (AC2): each component is written to a
// temp file and RENAMED into place, so a concurrent probe never reads a TORN
// component; a mid-staging probe reads either a coherent prefix or, when the
// staging lock is live, `staging-in-progress → unknown`. Write order is the
// declared order with the manifest LAST, so a racing reader that sees the
// new manifest has already seen the components it declares.
//
// THE LOCK (AC3): ONE lock per staging root (<destRoot>/modes/.staging-lock.
// json). The lock carries an owner liveness token — the process's START TIME
// (never a bare PID: PID reuse must not make a dead stager's lock look
// owned) — plus a TTL heartbeat the stager refreshes between components. A
// live holder aborts a second pass (aborted-locked). A lock past the TTL
// heartbeat, held by a dead process, or held by a reused PID (start-time
// mismatch) reads `stale-lock → failed` in the doctor's view and is STOLEN
// by the next staging pass after the owner-liveness check, the steal
// recorded on the deploy receipt.
//
// PLATFORM ASSUMPTION, STATED (AC10): rename(2) atomicity within a
// filesystem — POSIX. The fleet is POSIX today; Windows is served via the
// WSL/linux-x64 binary. A Windows-native target needs a different primitive
// before this pattern is copied there.
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname, basename, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  parseModeManifest,
  validateModeRegistry,
  checkConsumerFloor,
  classifyLedgerDiscoveryRegion,
  SUPPORTED_MODE_BUNDLE_VERSION,
  type ModeManifest,
} from "./mode_registry.js";
import type { Validation } from "./index.js";

export const MODE_STAGING_LOCK_NAME = ".staging-lock.json";
export const MODE_DEPLOY_RECEIPT_NAME = ".deploy-receipt.json";
export const MODE_STAGING_TTL_MS_DEFAULT = 120_000;

/** The staging root for a destination: <destRoot>/modes (sibling of the
 *  legacy agents/ dir in both deployed roots — the declared ../../ paths
 *  resolve identically source-side and deployed-side). */
export function modeBundleStagingRoot(destRoot: string): string {
  return join(destRoot, "modes");
}

// ── the liveness token (start-time, never bare PID) ─────────────────────────

/** Is a pid alive? (process.kill signal-0 probe; EPERM = exists, another
 *  user — single-operator assumption treats it as alive, as in
 *  amico-run's upgrade lock.) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The OS start-time token for a pid — the liveness evidence a bare PID
 *  cannot give (PID reuse must not make a dead stager's lock look owned).
 *  Linux: /proc/<pid>/stat's starttime (jiffies since boot, stable per
 *  boot; equality is all the check needs — a heartbeat older than any TTL
 *  covers the reboot edge). macOS/other: `ps -o lstart=`. Null when the
 *  platform cannot provide it (the heartbeat then governs). */
export function processStartTimeToken(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // field 2 (comm) may contain spaces/parens — parse AFTER the last ')'
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const starttime = rest[19]; // fields here start at 3; 22 - 3 = 19
      return starttime ?? null;
    } catch {
      return null;
    }
  }
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    if (r.status === 0 && r.stdout && r.stdout.trim().length > 0) return r.stdout.trim();
  } catch {
    // fall through
  }
  return null;
}

// ── the lock ────────────────────────────────────────────────────────────────

export interface ModeStagingLock {
  lock_version: number;
  staging_root: string;
  owner_pid: number;
  /** The owner's process start-time token — the liveness evidence. */
  owner_started: string;
  /** Per-process random token minted at acquisition. */
  liveness_token: string;
  acquired_at: string;
  /** Refreshed by the owner between components; the TTL's clock. */
  heartbeat_at: string;
  ttl_ms: number;
  /** A lock file that did not parse — reads stale (never a permanent wedge). */
  unparseable?: boolean;
}

export type StagingLockVerdict = "live" | "stale";

/** Read a staging root's lock; null when no lock file exists. An unparseable
 *  lock is returned with unparseable: true (the honest stale, never an
 *  exception — the doctor degrades, never dies). */
export function readStagingLock(modesDir: string): ModeStagingLock | null {
  const p = join(modesDir, MODE_STAGING_LOCK_NAME);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModeStagingLock>;
    return {
      lock_version: parsed.lock_version ?? 0,
      staging_root: parsed.staging_root ?? modesDir,
      owner_pid: parsed.owner_pid ?? 0,
      owner_started: parsed.owner_started ?? "",
      liveness_token: parsed.liveness_token ?? "",
      acquired_at: parsed.acquired_at ?? "",
      heartbeat_at: parsed.heartbeat_at ?? "",
      ttl_ms: parsed.ttl_ms ?? 0,
    };
  } catch {
    return {
      lock_version: 0,
      staging_root: modesDir,
      owner_pid: 0,
      owner_started: "",
      liveness_token: "",
      acquired_at: "",
      heartbeat_at: "",
      ttl_ms: 0,
      unparseable: true,
    };
  }
}

export interface LockVerdictOpts {
  /** Clock injection (verdict determinism); default real time. */
  now?: () => number;
}

/** Judge a lock: live ⇔ the owner pid is alive AND the pid's CURRENT
 *  start-time token matches the lock's recorded one (when both readable —
 *  the reused-PID guard) AND the heartbeat is within the TTL. Everything
 *  else — dead owner, stale heartbeat, start-time mismatch, unparseable —
 *  reads `stale` (the doctor renders stale-lock → failed; the stager steals
 *  after this check). */
export function stagingLockVerdict(lock: ModeStagingLock, opts: LockVerdictOpts = {}): StagingLockVerdict {
  if (lock.unparseable) return "stale";
  if (!pidAlive(lock.owner_pid)) return "stale";
  const currentStart = processStartTimeToken(lock.owner_pid);
  if (lock.owner_started !== "" && currentStart !== null && currentStart !== lock.owner_started) {
    return "stale"; // reused PID: the token must not let a dead stager look owned
  }
  const now = (opts.now ?? Date.now)();
  const heartbeat = Date.parse(lock.heartbeat_at);
  if (!Number.isFinite(heartbeat) || now - heartbeat > lock.ttl_ms) return "stale";
  return "live";
}

// ── the stager ───────────────────────────────────────────────────────────────

export interface StolenLock {
  from: ModeStagingLock;
  reason: string;
}

export interface ModeStagingOpts {
  /** Clock injection (receipt + lock timestamps); default real time. */
  now?: () => string;
  /** Lock TTL in ms (default 120s). */
  ttlMs?: number;
  /** The stager's supported mode-bundle version (floor check; default this
   *  build's SUPPORTED_MODE_BUNDLE_VERSION). */
  stagerVersion?: string;
  /** Test seam: fired after every component write + heartbeat refresh — the
   *  concurrent-probe simulation point. */
  tick?: () => void;
}

export interface StageModeBundlesResult {
  outcome: "staged" | "aborted-locked";
  /** The staging root (<destRoot>/modes). */
  dir: string;
  modes: Array<{ mode: string; files: Array<{ path: string; sha256: string }> }>;
  /** Locks stolen by this pass, with the liveness reason — recorded on the
   *  deploy receipt too. */
  steals: StolenLock[];
  receiptPath: string | null;
  detail: string[];
}

/** Write bytes atomically: temp file in the SAME directory, then rename over
 *  the destination (POSIX rename atomicity — the stated platform
 *  assumption). A reader sees the whole old file or the whole new file. */
function writeAtomic(destPath: string, bytes: string | Buffer): void {
  const tmp = join(dirname(destPath), `.${basename(destPath)}.tmp-${process.pid}`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, destPath);
}

const sha256hex = (buf: Buffer): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

/** Acquire the ONE lock for the staging root. Live holder → aborted-locked
 *  (the caller returns); stale → steal (recorded) and retry. */
function acquireLock(
  modesDir: string,
  opts: ModeStagingOpts,
  steals: StolenLock[],
  detail: string[],
): { acquired: boolean; reason?: string; liveness_token?: string } {
  const lockPath = join(modesDir, MODE_STAGING_LOCK_NAME);
  const ttl = opts.ttlMs ?? MODE_STAGING_TTL_MS_DEFAULT;
  const nowIso = opts.now ?? (() => new Date().toISOString());
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock: ModeStagingLock = {
      lock_version: 1,
      staging_root: modesDir,
      owner_pid: process.pid,
      owner_started: processStartTimeToken(process.pid) ?? "",
      liveness_token: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      acquired_at: nowIso(),
      heartbeat_at: nowIso(),
      ttl_ms: ttl,
    };
    try {
      const fh = openSync(lockPath, "wx");
      writeFileSync(fh, JSON.stringify(lock, null, 2) + "\n");
      closeSync(fh);
      return { acquired: true, liveness_token: lock.liveness_token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readStagingLock(modesDir);
      if (held === null) continue; // raced away — retry the create
      if (stagingLockVerdict(held) === "live") {
        return { acquired: false, reason: `staging in progress (lock held by a live stager, pid ${held.owner_pid}): ${lockPath}` };
      }
      const reason =
        held.unparseable
          ? "lock unparseable"
          : !pidAlive(held.owner_pid)
            ? "owner process dead"
            : held.owner_started !== "" && processStartTimeToken(held.owner_pid) !== null && processStartTimeToken(held.owner_pid) !== held.owner_started
              ? "owner start-time token mismatch (reused PID)"
              : "heartbeat past the TTL";
      detail.push(`stale staging lock stolen (${reason}; from pid ${held.owner_pid || "?"})`);
      steals.push({ from: held, reason });
      rmSync(lockPath, { force: true }); // steal — the steal is on the receipt
    }
  }
  return { acquired: false, reason: `could not acquire the staging lock after stale steals: ${lockPath}` };
}

/** Refresh the lock's heartbeat between components (atomic write — a probing
 *  doctor never reads a torn lock). The owner writes its own lock; a foreign
 *  stager is impossible here (one lock, holder-checked). */
function refreshHeartbeat(modesDir: string, opts: ModeStagingOpts): void {
  const lock = readStagingLock(modesDir);
  if (lock === null || lock.owner_pid !== process.pid) return; // not ours (stolen?) — stop touching it
  writeAtomic(join(modesDir, MODE_STAGING_LOCK_NAME), JSON.stringify({ ...lock, heartbeat_at: (opts.now ?? (() => new Date().toISOString()))() }, null, 2) + "\n");
}

/** Stage every mode bundle from the extension root into the destination
 *  root. The source registry must VALIDATE first (never stage what does not
 *  validate) and the stager's version must clear every bundle's stager
 *  floor (AC5: a gap aborts loudly). Throws on validation/floor failures —
 *  the activation caller catches and logs (staging must never kill
 *  activation). */
export function stageModeBundles(
  extensionRoot: string,
  destRoot: string,
  opts: ModeStagingOpts = {},
): StageModeBundlesResult {
  const modesDir = modeBundleStagingRoot(destRoot);
  const sourceModes = join(extensionRoot, "modes");
  const detail: string[] = [];
  const steals: StolenLock[] = [];

  // (1) the source registry validates — one shared validator, the same code
  // the doctor probes with. A broken source is a loud authoring failure.
  const v: Validation = validateModeRegistry(sourceModes, extensionRoot);
  if (!v.ok) {
    throw new Error(`mode registry validation failed — staging refused:\n${v.errors.map((e: string) => `  - ${e}`).join("\n")}`);
  }

  // (2) the stager's version clears every bundle's floor (loud gap, never a
  //  silent degrade)
  const stagerVersion = opts.stagerVersion ?? SUPPORTED_MODE_BUNDLE_VERSION;
  const manifests = readManifests(sourceModes);
  for (const [mode, manifest] of manifests) {
    const floor = checkConsumerFloor(manifest.consumer_floors, "stager", stagerVersion);
    if (!floor.ok) {
      throw new Error(`mode bundle "${mode}" ${floor.render} — staging refused`);
    }
  }

  // (3) the ONE lock for the staging root (the root exists before the lock —
  //  a fresh dest has no modes/ yet)
  mkdirSync(modesDir, { recursive: true });
  const lock = acquireLock(modesDir, opts, steals, detail);
  if (!lock.acquired) {
    detail.push(lock.reason ?? "lock refused");
    return { outcome: "aborted-locked", dir: modesDir, modes: [], steals, receiptPath: null, detail };
  }
  const ourLockToken = lock.liveness_token ?? "";
  // sweep crashed-pass tmp debris under the lock: no other live stager holds
  // one, so any *.tmp-<pid> file is an orphaned write-then-rename left-hand —
  // without the sweep it is permanent doctor staleness with no repair path
  sweepTmpDebris(modesDir, detail);

  const nowIso = opts.now ?? (() => new Date().toISOString());
  const modeRecords: StageModeBundlesResult["modes"] = [];
  let parity = "ok";
  try {
    for (const [mode, manifest] of manifests) {
      const bundleSrc = join(sourceModes, mode);
      const bundleDst = join(modesDir, mode);
      const files: Array<{ path: string; sha256: string }> = [];
      const writeComponent = (inBundle: string, sourceAbs: string): void => {
        const bytes = readFileSync(sourceAbs);
        const destPath = join(bundleDst, inBundle);
        mkdirSync(dirname(destPath), { recursive: true });
        writeAtomic(destPath, bytes); // POSIX rename — a probe never reads a torn component
        files.push({ path: inBundle, sha256: sha256hex(bytes) });
        refreshHeartbeat(modesDir, opts);
        opts.tick?.();
      };
      // declared order, manifest LAST: a racing reader that sees the new
      // manifest has already seen every component it declares
      writeComponent(manifest.card, join(bundleSrc, manifest.card));
      writeComponent(manifest.pack, join(bundleSrc, manifest.pack));
      for (const role of manifest.roles) {
        writeComponent(`roles/${role.name}.md`, resolveUnder(extensionRoot, bundleSrc, role.path));
      }
      for (const seed of manifest.handoff_seeds) {
        const base = seed.schema.replace(/^.*[\\/]/, "");
        writeComponent(`handoff-seeds/${base}`, resolveUnder(extensionRoot, bundleSrc, seed.schema));
      }
      writeComponent("mode.toml", join(bundleSrc, "mode.toml"));

      // post-stage parity (AC8): the STAGED card's generated region must
      // classify ok — regenerate-and-compare, asserted after the stage
      const staged = classifyLedgerDiscoveryRegion(readFileSync(join(bundleDst, manifest.card), "utf8"));
      if (staged.status !== "ok") {
        parity = `${mode}: ${staged.status}`;
        throw new Error(`post-stage parity failed for ${mode}: ${staged.detail}`);
      }
      modeRecords.push({ mode, files });
    }

    // (4) the deploy receipt (atomic) — the audit trail the doctor checks
    const receiptPath = join(modesDir, MODE_DEPLOY_RECEIPT_NAME);
    writeAtomic(
      receiptPath,
      JSON.stringify(
        {
          receipt_version: 1,
          staged_at: nowIso(),
          dir: modesDir,
          modes: modeRecords,
          steals,
          parity,
        },
        null,
        2,
      ) + "\n",
    );
    detail.push(`staged ${modeRecords.length} mode bundle(s) to ${modesDir}`);
    return { outcome: "staged", dir: modesDir, modes: modeRecords, steals, receiptPath, detail };
  } finally {
    // (5) release the lock — OWNERSHIP-CHECKED: a stalled-then-resumed owner
    // must not delete a thief's new lock (the liveness_token is the
    // disambiguator; an unconditional unlink would leave the thief staging
    // lockless). A crash mid-stage leaves a stale lock the doctor reads as
    // failed and the next pass steals.
    try {
      const held = readStagingLock(modesDir);
      if (held !== null && held.liveness_token === ourLockToken) {
        unlinkSync(join(modesDir, MODE_STAGING_LOCK_NAME));
      }
    } catch {
      // already gone (stolen?) — nothing to release
    }
  }
}

/** Remove tmp debris from crashed staging passes (write-then-rename's
 *  orphaned left-hand files). Runs under the lock — no live stager holds
 *  one, so any `*.tmp-<pid>` file is debris by construction. */
function sweepTmpDebris(root: string, detail: string[]): void {
  const walk = (rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile() && /\.tmp-\d+$/.test(e.name)) {
        rmSync(join(root, child), { force: true });
        detail.push(`swept tmp debris: ${child}`);
      }
    }
  };
  walk("");
}

function readManifests(sourceModes: string): Array<[string, ModeManifest]> {
  const out: Array<[string, ModeManifest]> = [];
  for (const e of readdirSync(sourceModes, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    out.push([e.name, parseModeManifest(readFileSync(join(sourceModes, e.name, "mode.toml"), "utf8"))]);
  }
  if (out.length === 0) throw new Error(`no mode bundles under ${sourceModes}`);
  return out;
}

/** Resolve a declared path (relative to the bundle dir) under the extension
 *  root — the same containment rule the validator enforces. */
function resolveUnder(extensionRoot: string, bundleDir: string, rel: string): string {
  const abs = resolve(bundleDir, rel);
  const root = resolve(extensionRoot);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`declared path resolves outside the extension root: ${rel}`);
  }
  return abs;
}
