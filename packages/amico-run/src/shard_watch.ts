// shard_watch.ts — `amico fleet shard-watch` (amicode#1306): the nightly client
// shard-divergence watch, detection only.
//
//   amico fleet shard-watch [--clients a,b] [--port <p>] [--alert-min <n>]
//                           [--db <path>] [--post <channel>] [--dry-run]
//
// Client machines can silently fork the chat store (the 2026-09-20 sweep found a live
// macbook shard 77 sessions ahead of canonical and a stale server holding port 4096 —
// amicode#1302 is the human-coordinated remediation this job detects FOR). For each
// configured client (SSH aliases the fleet tooling already knows) this check:
//   1. counts the client's session ids READ-ONLY and diffs them against the canonical
//      DB's ids — the collision-check shape from the chat-database recovery procedure;
//   2. asks whether a LIVE LOCAL listener holds the canonical port on the client and it
//      is NOT the ssh forward (a stale local server is a fork signal — green-passive
//      reporting of that would be the fleet widget's sin all over again);
//   3. emits ONE receipt line (timestamp, per-client results, verdicts) and, on
//      divergence in a real run, escalates through the existing fleet-alert convention
//      (the fleet channel via the amico-slack subprocess — never a new channel).
//
// CONSTRAINTS (the issue's invariants, enforced structurally):
//   - CLIENT DBS ARE NEVER WRITTEN. The probe interface below has no write surface at
//     all; the client census command is a pure string (`sqlite3 -readonly … SELECT`),
//     table-tested; the canonical read goes through the bridge's "ro" mode. The merge,
//     a kill, any remediation — out of the vocabulary (that is #1302's flow, by hand).
//   - UNREACHABLE ≠ DIVERGENT. A sleeping laptop is a warning row, never a fork.
//   - DIVERGENCE → NONZERO EXIT (1). Config/pre-flight errors exit 64 (skill-freshness
//     convention). Dry-run still detects and still exits nonzero — it only refrains
//     from appending the receipt and posting.
//
// PURITY BOUNDARY (mirrors fleet_digest.ts / session_retention.ts): compareShard,
// shardVerdict, checkClient, the command builders, and parseForkListener are total
// functions of their arguments — no fs, no clock, no spawn. Every impure edge (the
// canonical DB read, the ssh census, the listener probe, the escalation post, the
// clock, the env) is INJECTABLE via ShardWatchDeps, which is how the test suite runs
// the whole verb hermetically — no test touches network or a real DB.
import { spawnSync } from "node:child_process";
import { postViaAmicoSlack, type DigestPoster } from "./fleet_digest.js";
import { resolveSessionDb } from "./sessions_verb.js";
import { sqliteBatch } from "./sqlite_bridge.js";
import type { VerbResult } from "./verbs.js";

export const DEFAULT_CANONICAL_PORT = 4096;
export const DEFAULT_ALERT_MIN = 1;
/** Receipts carry a bounded sample of missing ids — the full count stays exact. */
export const MISSING_SAMPLE_LIMIT = 10;

// ── the pure comparison (the collision-check shape, table-tested) ────────────

export interface ShardComparison {
  alias: string;
  canonical_count: number;
  client_count: number;
  /** Client ids absent from canonical — THE divergence signal (a forked shard grows). */
  missing_count: number;
  missing_ids: string[]; // sorted, deduplicated
  /** Canonical ids absent from the client — a lagging replica; informational, never a verdict. */
  absent_from_client: number;
}

export function compareShard(alias: string, canonicalIds: readonly string[], clientIds: readonly string[]): ShardComparison {
  const canonical = new Set(canonicalIds);
  const client = new Set(clientIds);
  const missing_ids = [...client].filter((id) => !canonical.has(id)).sort();
  const absent_from_client = [...canonical].filter((id) => !client.has(id)).length;
  return {
    alias,
    canonical_count: canonical.size,
    client_count: client.size,
    missing_count: missing_ids.length,
    missing_ids,
    absent_from_client,
  };
}

// ── the verdicts ─────────────────────────────────────────────────────────────

export type ShardVerdict = "clean" | "warn" | "divergent" | "fork-signal" | "unreachable";

/** The alert threshold is CONFIG (default 1 = any missing id alerts — the conservative
 *  start): missing ≥ alertMin diverges, 0 < missing < alertMin is warn-only, zero is
 *  clean. The verdict is always data; the alerting threshold never hides a count. */
export function shardVerdict(missingCount: number, alertMin: number): "clean" | "warn" | "divergent" {
  if (missingCount <= 0) return "clean";
  return missingCount >= alertMin ? "divergent" : "warn";
}

// ── the probe seam (ALL probing lives behind this — tests inject it) ─────────

export type CensusResult = { ok: true; ids: string[] } | { ok: false; error: string };
export type ForkCheck = { ok: true; fork: boolean; detail: string } | { ok: false; error: string };

export interface ShardWatchProbes {
  /** Read-only session-id census of the CANONICAL DB (this job runs on the canonical host). */
  canonicalSessionIds(dbPath: string): CensusResult;
  /** Read-only session-id census of ONE client's chat DB, over the ssh mesh.
   *  ok:false = unreachable (a sleeping laptop is a warning, never a divergence). */
  clientSessionIds(alias: string, dbPath: string): CensusResult;
  /** Does a LIVE LOCAL listener hold the canonical port on this client, and is it NOT
   *  the ssh forward? ok:false = cannot determine (recorded as unknown, never guessed). */
  forkListener(alias: string, port: number): ForkCheck;
}

export interface ClientCheckOpts {
  dbPath: string;
  port: number;
  alertMin: number;
}

export interface ClientShardResult {
  alias: string;
  verdict: ShardVerdict;
  canonical_count?: number;
  client_count?: number;
  missing_count?: number;
  missing_sample?: string[];
  absent_from_client?: number;
  /** "fork" (live non-forward listener) | "none" | "unknown" (probe failed — honest). */
  fork_check?: "fork" | "none" | "unknown";
  fork_detail?: string;
  fork_error?: string;
  error?: string; // the unreachable reason
}

/** One client's verdict — pure given the probes. The fork signal outranks the count
 *  verdict (a stale local server on the canonical port is the incident itself); the
 *  counts are still reported in full so the receipt never loses the number to the label. */
export function checkClient(
  alias: string,
  canonicalIds: readonly string[],
  opts: ClientCheckOpts,
  probes: ShardWatchProbes,
): ClientShardResult {
  const census = probes.clientSessionIds(alias, opts.dbPath);
  if (!census.ok) return { alias, verdict: "unreachable", error: census.error };
  const cmp = compareShard(alias, canonicalIds, census.ids);
  const fk = probes.forkListener(alias, opts.port);
  const forkSignal = fk.ok && fk.fork;
  return {
    alias,
    verdict: forkSignal ? "fork-signal" : shardVerdict(cmp.missing_count, opts.alertMin),
    canonical_count: cmp.canonical_count,
    client_count: cmp.client_count,
    missing_count: cmp.missing_count,
    missing_sample: cmp.missing_ids.slice(0, MISSING_SAMPLE_LIMIT),
    absent_from_client: cmp.absent_from_client,
    fork_check: fk.ok ? (fk.fork ? "fork" : "none") : "unknown",
    ...(fk.ok ? { fork_detail: fk.detail } : { fork_error: fk.error }),
  };
}

// ── the command builders (pure strings — the read-only assertions) ───────────

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The client census: sqlite3 READONLY, SELECT only, stderr dropped (a client without
 *  the sqlite3 CLI fails the ssh call and reads as unreachable — an honest unknown,
 *  never a fabricated empty census). */
export function clientCensusCommand(dbPath: string): string {
  return `sqlite3 -readonly ${shQuote(dbPath)} 'SELECT id FROM session' 2>/dev/null`;
}

/** The listener census: LISTENers on the canonical port only, exit laundered (lsof
 *  exits 1 on no matches — "nothing listening" is data, not failure). */
export function forkListenerCommand(port: number): string {
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`;
}

/** Parse the lsof census. fork = a live listener that is NOT the ssh forward (ssh/sshd
 *  hold the tunnel endpoint; anything else bound to the canonical port is a local
 *  server answering on it — the stale-mini-server shape). */
export function parseForkListener(stdout: string): { listeners: string[]; fork: boolean } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const data = lines.length > 0 && lines[0].startsWith("COMMAND") ? lines.slice(1) : lines;
  const listeners = data.map((l) => l.split(/\s+/)[0]).filter(Boolean);
  const fork = listeners.some((c) => c !== "ssh" && c !== "sshd");
  return { listeners, fork };
}

// ── the default probes (the impure edge; tests inject ShardWatchProbes) ──────

const SSH_FLAGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6"];

/** Canonical read through the bridge's "ro" mode (the open-threads discipline: the hub
 *  owns the live DB; this job opens READ-ONLY, always). */
export function sqliteBridgeCensus(dbPath: string): CensusResult {
  try {
    const batch = sqliteBatch(dbPath, "ro", [{ sql: "SELECT id FROM session" }]);
    return { ok: true, ids: batch.results[0].rows.map((r) => String(r.id)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function sshClientCensus(alias: string, dbPath: string): CensusResult {
  const r = spawnSync("ssh", [...SSH_FLAGS, alias, clientCensusCommand(dbPath)], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) {
    const err = ((r.stderr || "") as string).trim().split("\n")[0] || `ssh exited ${r.status ?? "?"}`;
    return { ok: false, error: err.slice(0, 160) };
  }
  return { ok: true, ids: (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean) };
}

export function sshForkListener(alias: string, port: number): ForkCheck {
  const r = spawnSync("ssh", [...SSH_FLAGS, alias, forkListenerCommand(port)], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) {
    const err = ((r.stderr || "") as string).trim().split("\n")[0] || `ssh exited ${r.status ?? "?"}`;
    return { ok: false, error: err.slice(0, 160) };
  }
  const p = parseForkListener(r.stdout || "");
  return { ok: true, fork: p.fork, detail: p.listeners.length > 0 ? p.listeners.join(",") : "none listening" };
}

function defaultProbes(): ShardWatchProbes {
  return {
    canonicalSessionIds: sqliteBridgeCensus,
    clientSessionIds: sshClientCensus,
    forkListener: sshForkListener,
  };
}

// ── the escalation rendering (pure; posted through the digest's amico-slack contract) ──

export function formatDivergenceBlock(
  ts: string,
  divergent: ClientShardResult[],
  port: number,
  dbPath: string,
): string {
  const lines: string[] = [`*shard watch — ${ts}*`, "Client shard divergence detected (detection only — remediation is the human-coordinated #1302 flow):"];
  for (const c of divergent) {
    const what =
      c.verdict === "fork-signal"
        ? `fork signal — live local listener on the canonical port${c.fork_detail ? ` (${c.fork_detail})` : ""}`
        : `${c.missing_count} session id(s) absent from canonical (client ${c.client_count} · canonical ${c.canonical_count})`;
    lines.push(`• \`${c.alias}\` — ${what}`);
  }
  lines.push(`canonical: \`${dbPath}\` · port ${port} · per-client detail in the shard-watch receipt line`);
  return lines.join("\n");
}

// ── the verb ─────────────────────────────────────────────────────────────────

export interface ShardWatchDeps {
  probes?: ShardWatchProbes;
  post?: DigestPoster;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function shardFail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return {
    json: { receipt_version: 1, verb: "fleet", subcommand: "shard-watch", kind: "shard-watch", ok: false, error, ...extra },
    code: 64,
  };
}

/** `amico fleet shard-watch` — the nightly check. Exit 1 on divergence (including any
 *  fork signal), 0 otherwise, 64 on config/pre-flight errors. */
export function shardWatch(argv: string[], deps: ShardWatchDeps = {}): VerbResult {
  const env = deps.env ?? process.env;
  const now = deps.now ? deps.now() : Date.now();
  const ts = new Date(now).toISOString();
  const dryRun = argv.includes("--dry-run");

  // configuration: flags > env > defaults (no hardcoded host, alias, or channel — the
  // fleet digest's no-topology invariant, again)
  const clientsRaw = flagValue(argv, "--clients") ?? env.AMICO_SHARD_CLIENTS ?? "";
  const clients = clientsRaw.split(",").map((a) => a.trim()).filter(Boolean);
  if (clients.length === 0) {
    return shardFail("no clients configured — pass --clients a,b or set AMICO_SHARD_CLIENTS (the ssh aliases the fleet tooling already knows); a watch that watches nothing must not silently pass");
  }
  const alertMinRaw = flagValue(argv, "--alert-min") ?? env.AMICO_SHARD_ALERT_MIN ?? String(DEFAULT_ALERT_MIN);
  const alertMin = Number(alertMinRaw);
  if (!Number.isInteger(alertMin) || alertMin < 1) {
    return shardFail(`--alert-min must be a positive integer (got "${alertMinRaw}") — the alert threshold never silently widens`);
  }
  const portRaw = flagValue(argv, "--port") ?? env.AMICO_CANONICAL_PORT ?? String(DEFAULT_CANONICAL_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return shardFail(`--port must be a TCP port (got "${portRaw}")`);
  }
  const dbPath = resolveSessionDb(argv, env);
  const channel = flagValue(argv, "--post") ?? env.AMICO_SLACK_FLEET_CHANNEL ?? "";

  // pre-flight: the canonical census. A canonical DB we cannot read is a failed check,
  // never a green "clean" (there would be nothing to diff against).
  const probes = deps.probes ?? defaultProbes();
  const canonical = probes.canonicalSessionIds(dbPath);
  if (!canonical.ok) {
    return shardFail(`canonical DB unreadable: ${canonical.error}`, { canonical_db: dbPath });
  }

  const results = clients.map((alias) => checkClient(alias, canonical.ids, { dbPath, port, alertMin }, probes));
  const divergent = results.filter((r) => r.verdict === "divergent" || r.verdict === "fork-signal");
  const unreachable = results.filter((r) => r.verdict === "unreachable");
  const warnings = unreachable.map((r) => `client ${r.alias} unreachable: ${r.error} — a warning, not a divergence`);
  const verdict = divergent.length > 0 ? "divergent" : "clean";

  const json: Record<string, unknown> = {
    receipt_version: 1,
    ts,
    verb: "fleet",
    subcommand: "shard-watch",
    kind: "shard-watch",
    ok: verdict === "clean",
    port,
    canonical_db: dbPath,
    canonical_count: canonical.ids.length,
    alert_min: alertMin,
    clients: results,
    divergent_clients: divergent.map((r) => r.alias),
    unreachable_clients: unreachable.map((r) => r.alias),
    verdict,
    dry_run: dryRun,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  // Escalation rides the existing fleet-alert convention: the fleet channel, through the
  // amico-slack subprocess (deps.post default postViaAmicoSlack — the digest's contract).
  // Real runs only; a dry-run WOULD-DOes. A failed post is errors-as-data: it never
  // changes the verdict and never softens the exit code.
  if (verdict === "divergent") {
    if (dryRun) {
      json.escalation = `WOULD-DO: post the divergence summary to the fleet channel via amico-slack (${divergent.map((r) => r.alias).join(", ")})`;
    } else if (channel === "") {
      json.escalation = "divergence detected but no channel configured — set AMICO_SLACK_FLEET_CHANNEL or pass --post <channel>; receipt only this run";
    } else {
      const post = deps.post ?? postViaAmicoSlack;
      const res = post(channel, formatDivergenceBlock(ts, divergent, port, dbPath), formatDivergenceBlock(ts, divergent, port, dbPath));
      if (res.ok) {
        json.escalated = true;
        if (res.ts) json.escalation_ts = res.ts;
      } else {
        json.escalation_failed = true;
        json.escalation_error = (res.errors ?? ["post failed"]).join("; ");
        json.warnings = [...warnings, `escalation post failed: ${json.escalation_error}`];
      }
    }
  }

  return { json, code: verdict === "divergent" ? 1 : 0 };
}
