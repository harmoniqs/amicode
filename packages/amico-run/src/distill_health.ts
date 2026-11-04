// Distill-queue health for `amico vault status` and `amico doctor` (amicode#2098).
//
// A READ-ONLY reader of the extension's distill queue — it never imports extension
// code; the queue's on-disk naming is the only contract. The grammar is documented at
// the top of packages/extension/opencode-plugin/distill_queue.ts (the writer); keep the
// two in step. Files in `<ops>/distill-queue/`:
//
//   <base>.json                READY (offered now)
//   <base>.json.failed-<ms>    set aside after a failure. With a valid ledger
//                              `<base>.json.attempts` ({attempt, last_error, last_at,
//                              not_before}) it is BACKING OFF until `not_before`, then
//                              RETRY-DUE. Without one it is a pre-#2098 file: one prior
//                              attempt, unknown error → OLD-FORMAT-FAILED (retry-eligible).
//   <base>.json.parked-<ms>    TERMINAL — needs a human; counted, never deleted/retried.
//   <ops>/distill-halt.json    present iff the drain is HALTED ({reason, at, consecutive}).
//
// OPS DIR: `amicodeOpsDir(env)` (`$AMICODE_OPS_DIR` else `~/.amico/amicode`) — where the
// queue lives. NOTE: sync records live under `$AMICO_OPS_ROOT` (vault_sync.ts); that
// disagreement is amicode#1998 and is deliberately NOT fixed here.
//
// Never throws, never mutates: absent/empty/malformed input degrades to zero counts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DistillHealth {
  ready: number;
  /** Failed, backoff not yet passed. */
  backing_off: number;
  /** Failed with a ledger, backoff passed — the next drain retries it. */
  retry_due: number;
  parked: number;
  /** Pre-#2098 `.failed-<ms>` files (one attempt, unknown error); eligible for retry. */
  old_format_failed: number;
  oldest_ready_age_s: number | null;
  halt?: { reason: string; at: number; consecutive: number };
}

const STATE_NAME = /^(.+\.json)(?:\.(failed|parked)-(\d+))?$/;

export function readDistillHealth(opsDir: string, now: number = Date.now()): DistillHealth {
  const health: DistillHealth = { ready: 0, backing_off: 0, retry_due: 0, parked: 0, old_format_failed: 0, oldest_ready_age_s: null };
  try {
    const dir = join(opsDir, "distill-queue");
    let oldest: number | null = null;
    for (const name of readdirSync(dir)) {
      const m = STATE_NAME.exec(name);
      if (!m) continue;
      if (!m[2]) {
        health.ready++;
        const enqueued = enqueuedAt(dir, name, m[1]);
        if (enqueued !== null && (oldest === null || enqueued < oldest)) oldest = enqueued;
      } else if (m[2] === "parked") health.parked++;
      else {
        const notBefore = ledgerNotBefore(dir, m[1]);
        if (notBefore === null) health.old_format_failed++;
        else if (notBefore > now) health.backing_off++;
        else health.retry_due++;
      }
    }
    if (oldest !== null) health.oldest_ready_age_s = Math.max(0, Math.floor((now - oldest) / 1000));
  } catch {
    // an absent / unreadable queue dir reads as empty
  }
  const halt = readHalt(opsDir);
  if (halt) health.halt = halt;
  return health;
}

/** The doctor check: `warn` for parked jobs or a halted drain (naming the fix),
 *  `ok` otherwise. Never `error` — a backlog is a to-do, not a broken install. */
export function distillQueueCheck(h: DistillHealth): { name: "distill_queue"; status: "ok" | "warn"; detail: string } {
  const summary =
    `${h.ready} ready, ${h.backing_off + h.retry_due} retrying, ${h.parked} parked, ${h.old_format_failed} old-format failed` +
    (h.oldest_ready_age_s !== null ? `, oldest ready ${h.oldest_ready_age_s}s old` : "");
  const problems: string[] = [];
  if (h.halt) {
    problems.push(`drain HALTED (${h.halt.reason}) — fix the cause (binary / credential / model access), then reset the halt (delete distill-halt.json in the ops dir)`);
  }
  if (h.parked > 0) {
    problems.push(`${h.parked} parked job${h.parked === 1 ? "" : "s"} need a human — inspect <ops>/distill-queue/*.parked-* (and each job's .attempts ledger for the last error)`);
  }
  if (problems.length === 0) return { name: "distill_queue", status: "ok", detail: summary };
  return { name: "distill_queue", status: "warn", detail: `${problems.join("; ")} [${summary}]` };
}

/** Enqueue time: the leading `<ms>-` of the job's name, else the file's mtime. */
function enqueuedAt(dir: string, name: string, base: string): number | null {
  const lead = /^(\d{12,})-/.exec(base);
  if (lead) return Number(lead[1]);
  try {
    return statSync(join(dir, name)).mtimeMs;
  } catch {
    return null;
  }
}

function ledgerNotBefore(dir: string, base: string): number | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, `${base}.attempts`), "utf8"));
    const nb = (v as { not_before?: unknown } | null)?.not_before;
    return typeof nb === "number" && Number.isFinite(nb) ? nb : null;
  } catch {
    return null;
  }
}

function readHalt(opsDir: string): DistillHealth["halt"] {
  try {
    const v = JSON.parse(readFileSync(join(opsDir, "distill-halt.json"), "utf8")) as { reason?: unknown; at?: unknown; consecutive?: unknown } | null;
    if (!v || typeof v.reason !== "string") return undefined;
    return { reason: v.reason, at: Number(v.at ?? 0), consecutive: Number(v.consecutive ?? 0) };
  } catch {
    return undefined;
  }
}
