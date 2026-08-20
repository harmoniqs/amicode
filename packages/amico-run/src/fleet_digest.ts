// fleet_digest.ts — `amico fleet digest` (unified-fleet spec slice 1, amicode#428):
//   amico fleet digest [--post <channel>] [--dry-run] [--machines a,b] [--jobs-line "<t>"] [--root D]
//
// THE FOURTH RENDERING. The fleet doctrine (fleet_verb.ts header) says every fleet
// surface — dashboard widget, in-chat /fleet, Amico answering "how's the fleet?" — is a
// rendering of the deterministic verbs, "so the fleet layer never has to speak and never
// has two answers." This module adds Slack as the fourth: it READS the registry (via
// readAllRecords, never recomputing state) and probes configured machines, formats a
// ≤6-line distilled block plus a full table for the thread reply, and posts through the
// `amico-slack` CLI as a SUBPROCESS CONTRACT. No Slack API code lives here — posting,
// voice, and footer logic are the CLI's job; if it is not on PATH, that is errors-as-data,
// not a crash.
//
// PURITY BOUNDARY (mirrors fleet_registry.ts): formatDigestBlock/formatDigestTable/
// summarizeSessions are total functions of their arguments — no fs, no clock, no spawn.
// The impure edge (ssh probe, amico-slack subprocess, registry read, clock) is confined
// to fleetDigest() and is INJECTABLE via DigestDeps, which is how the test suite runs
// the whole verb hermetically.
//
// NO TOPOLOGY IN PRODUCT CODE (spec invariant): machine aliases come from --machines or
// AMICO_FLEET_MACHINES, the channel from --post or AMICO_SLACK_FLEET_CHANNEL — never a
// hardcoded host or channel name. Unconfigured machines render an honest "n/a" line;
// a down machine is a row, never a failed digest (degrade-graceful: the digest ALWAYS
// renders, because a digest that dies when one machine sleeps is worse than no digest).
// The Notturno wrapper (harmoniqs/amico#340) injects its jobs rollup via --jobs-line so
// this module never learns about Notturno.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_STATES,
  fleetRoot,
  isTerminal,
  readAllRecords,
  type FleetRecord,
  type FleetState,
} from "./fleet_registry.js";
import type { VerbResult } from "./verbs.js";

// ── the view (pure) ──────────────────────────────────────────────────────────────

export interface MachineProbe {
  alias: string;
  ok: boolean;
  detail: string;
}

export interface DigestSessionRow {
  session_id: string;
  state: FleetState;
  host: string;
  age: string; // "" when started is unknown
}

export interface DigestView {
  date: string; // YYYY-MM-DD
  machines: MachineProbe[] | null; // null = machine list not configured
  sessions: {
    total: number;
    byState: Record<string, number>;
    live: DigestSessionRow[];
    terminal: number;
    unreadable: number;
  };
  jobsLine?: string;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Human age from a duration in ms: "12m" · "4h12m" · "3d2h". Sub-minute → "now". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

export function summarizeSessions(records: FleetRecord[], unreadable: number, now: number): DigestView["sessions"] {
  const byState: Record<string, number> = {};
  for (const s of FLEET_STATES) byState[s] = 0;
  for (const r of records) byState[r.state] += 1;
  const live: DigestSessionRow[] = records
    .filter((r) => !isTerminal(r.state))
    .map((r) => {
      const started = r.started === "" ? NaN : Date.parse(r.started);
      return {
        session_id: r.session_id,
        state: r.state,
        host: r.host,
        age: Number.isFinite(started) ? formatAge(now - started) : "",
      };
    })
    .sort((a, b) => a.session_id.localeCompare(b.session_id));
  return { total: records.length, byState, live, terminal: byState.killed ?? 0, unreadable };
}

/** The ≤6-line distilled block — the only part that lands top-level in the channel. */
export function formatDigestBlock(v: DigestView): string {
  const lines: string[] = [`*Fleet — ${v.date}*`];
  if (v.machines === null) {
    lines.push("machines: n/a (not configured)");
  } else {
    lines.push(
      "machines: " +
        (v.machines.length === 0
          ? "n/a (none configured)"
          : v.machines.map((m) => `${m.alias} ${m.ok ? "✓" : "✗"}`).join(" · ")),
    );
  }
  const s = v.sessions;
  lines.push(
    s.total === 0
      ? "sessions: 0 live (registry empty)"
      : `sessions: ${s.live.length} live of ${s.total} (${FLEET_STATES.filter((st) => s.byState[st] > 0)
          .map((st) => `${st} ${s.byState[st]}`)
          .join(" · ")})`,
  );
  if (v.jobsLine !== undefined && v.jobsLine !== "") lines.push(`jobs: ${v.jobsLine}`);
  return lines.join("\n");
}

/** The full table — posted as the thread reply; the block is the summary, this is the data. */
export function formatDigestTable(v: DigestView, rootPath: string): string {
  const lines: string[] = [];
  lines.push("*Machines*");
  if (v.machines === null || v.machines.length === 0) {
    lines.push("  (not configured — pass --machines or set AMICO_FLEET_MACHINES)");
  } else {
    for (const m of v.machines) {
      lines.push(`  ${m.alias.padEnd(18)} ${m.ok ? "✓" : "✗"}  ${m.detail}`);
    }
  }
  lines.push("");
  lines.push(`*Sessions* — registry ${rootPath}`);
  const s = v.sessions;
  if (s.total === 0) {
    lines.push("  0 records — nothing has populated the registry yet");
  } else {
    lines.push(`  total ${s.total} (${FLEET_STATES.map((st) => `${st} ${s.byState[st]}`).join(" · ")})`);
    if (s.live.length === 0) {
      lines.push("  no live sessions");
    } else {
      for (const r of s.live) {
        lines.push(`  ${r.session_id}  ${r.state}  ${r.host}${r.age ? `  ${r.age}` : ""}`);
      }
    }
  }
  if (s.unreadable > 0) lines.push(`  ⚠️ ${s.unreadable} unreadable record(s) in the registry root`);
  return lines.join("\n");
}

// ── the impure edge (injectable) ─────────────────────────────────────────────────

export type DigestPoster = (
  channel: string,
  block: string,
  table: string,
) => { ok: boolean; ts?: string; errors?: string[]; warnings?: string[] };

export interface DigestDeps {
  probe?: (alias: string) => MachineProbe;
  post?: DigestPoster;
  now?: () => number;
}

/** One machine probe over the SSH mesh (the /fleet skill's reachability check, in code). */
export function sshProbe(alias: string): MachineProbe {
  const r = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", alias, "echo ok; hostname"],
    { encoding: "utf8", timeout: 8000 },
  );
  if (r.status === 0) {
    const out = (r.stdout || "").trim().split("\n").filter(Boolean);
    return { alias, ok: true, detail: out[out.length - 1] ?? alias };
  }
  const err = ((r.stderr || "") as string).trim().split("\n")[0] || `exit ${r.status ?? "?"}`;
  return { alias, ok: false, detail: err.slice(0, 80) };
}

/** The subprocess contract: `amico-slack send <ch> --file <f> [--thread <ts>]` → "sent → … ts=<TS>". */
function amicoSlackSend(args: string[]): { ok: boolean; stdout: string; error?: string } {
  const r = spawnSync("amico-slack", args, { encoding: "utf8", timeout: 60_000 });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    const hint =
      code === "ENOENT"
        ? "amico-slack not found on PATH — install the CLI (unified-fleet slice 2 ships it) or run with --dry-run"
        : String(r.error.message ?? r.error);
    return { ok: false, stdout: "", error: hint };
  }
  if (r.status !== 0) {
    const tail = ((r.stderr || "") + "\n" + (r.stdout || "")).trim().split("\n").pop() ?? "";
    return { ok: false, stdout: r.stdout || "", error: tail || `amico-slack exit ${r.status}` };
  }
  return { ok: true, stdout: r.stdout || "" };
}

/** Default poster: block top-level, table as a thread reply. The block going out outranks
 *  the thread reply — a table failure is a warning, not a failed digest. */
export function postViaAmicoSlack(channel: string, block: string, table: string): {
  ok: boolean;
  ts?: string;
  errors?: string[];
  warnings?: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "amico-fleet-digest-"));
  try {
    const blockFile = join(dir, "block.md");
    writeFileSync(blockFile, block, "utf8");
    const r1 = amicoSlackSend(["send", channel, "--file", blockFile]);
    if (!r1.ok) return { ok: false, errors: [r1.error ?? "amico-slack send failed"] };
    const ts = /ts=([0-9.]+)/.exec(r1.stdout)?.[1];
    const tableFile = join(dir, "table.md");
    writeFileSync(tableFile, table, "utf8");
    const args = ["send", channel, "--file", tableFile];
    if (ts) args.push("--thread", ts);
    const r2 = amicoSlackSend(args);
    if (!r2.ok) return { ok: true, ts, warnings: [`thread table not posted: ${r2.error ?? "failed"}`] };
    return { ok: true, ts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the verb ─────────────────────────────────────────────────────────────────────

export function fleetDigest(argv: string[], deps: DigestDeps = {}): VerbResult {
  const subcommand = "digest";
  // channel resolution: --post flag > AMICO_SLACK_FLEET_CHANNEL env; absent → dry-run
  const channel = flagValue(argv, "--post") ?? process.env.AMICO_SLACK_FLEET_CHANNEL ?? "";
  const isPost = channel !== "" && !argv.includes("--dry-run");
  const machinesArg = flagValue(argv, "--machines") ?? process.env.AMICO_FLEET_MACHINES ?? "";
  const jobsLine = flagValue(argv, "--jobs-line");
  const root = fleetRoot(flagValue(argv, "--root"));
  const now = deps.now ? deps.now() : Date.now();

  const machines: MachineProbe[] | null =
    machinesArg.trim() === ""
      ? null
      : machinesArg
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
          .map((alias) => (deps.probe ? deps.probe(alias) : sshProbe(alias)));

  const { records, unreadable } = readAllRecords(root);
  const view: DigestView = {
    date: new Date(now).toISOString().slice(0, 10),
    machines,
    sessions: summarizeSessions(records, unreadable.length, now),
    ...(jobsLine !== undefined ? { jobsLine } : {}),
  };

  const block = formatDigestBlock(view);
  const table = formatDigestTable(view, root);

  const base: Record<string, unknown> = {
    verb: "fleet",
    subcommand,
    ok: true,
    root,
    channel,
    machines: machines ?? [],
    sessions: {
      total: view.sessions.total,
      live: view.sessions.live.length,
      byState: view.sessions.byState,
      unreadable: view.sessions.unreadable,
    },
    block,
    table,
  };

  if (!isPost) {
    return { json: { ...base, dry_run: true }, code: 0 };
  }

  const post = deps.post ?? postViaAmicoSlack;
  const res = post(channel, block, table);
  if (!res.ok) {
    return { json: { ...base, ok: false, dry_run: false, errors: res.errors ?? ["post failed"] }, code: 64 };
  }
  return {
    json: { ...base, dry_run: false, posted: true, ...(res.ts ? { ts: res.ts } : {}), ...(res.warnings ? { warnings: res.warnings } : {}) },
    code: 0,
  };
}
