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
// The Notturno wrapper (harmoniqs/amicissimo#340) injects its jobs rollup via --jobs-line so
// this module never learns about Notturno.
//
// VAULT HEALTH + MIGRATION DEBT (vault-management spec M4, amico#361): the digest gains
// per-machine vault-health rows — the layout invariant (~/.amico/vaults and
// ~/armonia/data/vaults must resolve to the same storage), the sync-state sidecar's last
// line ("no-sidecar" on a pre-upgrade machine is an honest value, not an error), and the
// scheduler state (loaded vs written-only) — plus a migration-debt checklist that renders
// until closed. A down machine renders an explicit parked state with the named re-check
// trigger (the fleet ritual), never a fake pass; a REACHABLE but misaligned machine
// FAILS the digest (errors-as-data at exit 64 — the digest still renders, but the layout
// invariant is a failure, not a warning).
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

/** One machine's vault health (vault-management spec M4, amico#361). GATHERED facts —
 *  every field is what the machine said, or an honest "can't know", never a guess. */
export type VaultLayout = "aligned" | "misaligned" | "unprobeable";
export type VaultScheduler = "loaded" | "written-only" | "unknown";
export type VaultConfigRes = "resolved" | "foreign-home" | "absent" | "unknown";

export interface VaultHealth {
  alias: string;
  /** The layout invariant: both `~/.amico/vaults` and `~/armonia/data/vaults` resolve to
   *  the same storage. `unprobeable` = machine down / ssh failed / garbled output. */
  layout: VaultLayout;
  /** The LAST line of the machine's `armonia-vault-status`; "no-sidecar" on a
   *  pre-upgrade machine (an honest value, not an error); "unknown" when unreadable. */
  sync_state: string;
  /** The sync scheduler: loaded (systemd user timer active or launchd agent found),
   *  written-only (configured but not active), unknown (no manager to ask). */
  scheduler: VaultScheduler;
  /** Config resolution (amico#361 AC): the distiller config's home-shaped paths must
   *  resolve on THIS machine — a `/Users/` string surviving on a non-Mac home is
   *  `foreign-home` (the 2026-09-02 found incident); `absent` when no config exists;
   *  `unknown` when unreadable. Never a guessed pass. */
  config: VaultConfigRes;
}

/** One migration-debt ledger item (spec M4's ledger). Rows render until closed. */
export interface MigrationDebtItem {
  id: string;
  label: string;
  state: "open" | "closed";
  owner: string;
}

/** The current migration debt (spec M4's ledger) — the single source the digest renders.
 *  Edit the array as items close; open items keep rendering, closed ones drop off.
 *  Ids and labels carry NO machine aliases: machines are configuration (the
 *  no-topology-invariant below), never source literals. */
export const MIGRATION_DEBT: MigrationDebtItem[] = [
  { id: "partitura-archived", label: "conflicted clone parked in vaults-archive", state: "open", owner: "content resolution" },
  { id: "compat-symlinks", label: "removal gated on confirmation", state: "open", owner: "Aaron's no-session-broke confirmation" },
  { id: "sync-script-rollout", label: "new sidecar script deploys fleet-wide post-merge", state: "closed", owner: "post-merge deploy — DONE 2026-09-02: deployed fleet-wide (live-pilot machine first, then every other machine), boards all-OK everywhere, backups kept" },
];

/** How a VaultHealth layout renders: the parked state names its re-check trigger —
 *  the fleet ritual flips it — so an unreachable machine is never mistaken for a pass. */
const LAYOUT_ROW_LABEL: Record<VaultLayout, string> = {
  aligned: "aligned",
  misaligned: "misaligned",
  unprobeable: "unverified (parked; owner: fleet ritual)",
};

export interface DigestSessionRow {
  session_id: string;
  state: FleetState;
  host: string;
  age: string; // "" when started is unknown
}

export interface DigestView {
  date: string; // YYYY-MM-DD
  machines: MachineProbe[] | null; // null = machine list not configured
  vaults?: VaultHealth[] | null; // undefined = vault health not part of this view (back-compat); null = machines not configured
  sessions: {
    total: number;
    byState: Record<string, number>;
    live: DigestSessionRow[];
    terminal: number;
    unreadable: number;
  };
  debt?: MigrationDebtItem[]; // defaults to MIGRATION_DEBT
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
  if (v.vaults !== undefined) {
    if (v.vaults === null || v.vaults.length === 0) {
      lines.push("vaults: n/a (not configured)");
    } else {
      const counts = { aligned: 0, misaligned: 0, unverified: 0 };
      for (const vh of v.vaults) {
        if (vh.layout === "aligned") counts.aligned += 1;
        else if (vh.layout === "misaligned") counts.misaligned += 1;
        else counts.unverified += 1;
      }
      const debtOpen = (v.debt ?? MIGRATION_DEBT).filter((d) => d.state === "open").length;
      const segs = [
        ...(counts.aligned > 0 ? [`${counts.aligned} aligned`] : []),
        ...(counts.misaligned > 0 ? [`${counts.misaligned} misaligned`] : []),
        ...(counts.unverified > 0 ? [`${counts.unverified} unverified`] : []),
      ];
      lines.push(`vaults: ${segs.join(" · ")} · debt ${debtOpen} open`);
    }
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
  if (v.vaults !== undefined) {
    lines.push("");
    lines.push("*Vaults* — per-machine layout invariant · sync state · scheduler");
    if (v.vaults === null || v.vaults.length === 0) {
      lines.push("  (not configured — pass --machines or set AMICO_FLEET_MACHINES)");
    } else {
      for (const vh of v.vaults) {
        lines.push(`  ${vh.alias.padEnd(18)} layout ${LAYOUT_ROW_LABEL[vh.layout]} · sync ${vh.sync_state} · scheduler ${vh.scheduler} · config ${vh.config}`);
      }
    }
    lines.push("");
    lines.push("*Migration debt* — tracked until closed");
    const open = (v.debt ?? MIGRATION_DEBT).filter((d) => d.state === "open");
    if (open.length === 0) {
      lines.push("  (no open items)");
    } else {
      for (const d of open) {
        lines.push(`  ${d.id}  open — ${d.label} (owner: ${d.owner})`);
      }
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
  vaultProbe?: (alias: string) => VaultHealth;
  debt?: MigrationDebtItem[];
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

/** The remote half of the vault probe — ONE ssh invocation gathering all three facts,
 *  POSIX sh, failure-tolerant PER FIELD: every branch echoes something, so a partially
 *  provisioned machine still parses (its honest values, never an error). `cd -P` +
 *  `pwd -P` resolve through symlinks without depending on GNU realpath. */
const VAULT_PROBE_REMOTE = [
  'a=$(cd -P "$HOME/.amico/vaults" 2>/dev/null && pwd -P);',
  'b=$(cd -P "$HOME/armonia/data/vaults" 2>/dev/null && pwd -P);',
  'if [ -n "$a" ] && [ -n "$b" ] && [ "$a" = "$b" ]; then echo "LAYOUT:aligned"; else echo "LAYOUT:misaligned"; fi',
  'if command -v armonia-vault-status >/dev/null 2>&1; then echo "SYNC:$(armonia-vault-status 2>/dev/null | tail -n 1)"; else echo "SYNC:no-sidecar"; fi',
  's=unknown; if command -v systemctl >/dev/null 2>&1; then',
  'if [ "$(systemctl --user is-active armonia-sync.timer 2>/dev/null)" = "active" ]; then s=loaded; else s=written-only; fi;',
  'elif command -v launchctl >/dev/null 2>&1; then',
  'if launchctl list 2>/dev/null | grep -q armonia-sync; then s=loaded; else s=written-only; fi;',
  'fi; echo "SCHED:$s"',
  'c=absent; f="$HOME/.amico/amicode/distiller.config.json";',
  'if [ -f "$f" ]; then c=resolved;',
  'if grep -q "/Users/" "$f" && [ "${HOME#/Users/}" = "$HOME" ]; then c=foreign-home; fi; fi;',
  'echo "CONFIG:$c"',
].join(" ");

/** Parse the vault probe's delimited output. A machine that answered without a parseable
 *  LAYOUT line is UNPROBEABLE — the parked state, never a guessed pass. */
export function parseVaultHealth(alias: string, stdout: string): VaultHealth {
  const layoutRaw = /LAYOUT:(\S+)/.exec(stdout)?.[1];
  const layout: VaultLayout =
    layoutRaw === "aligned" ? "aligned" : layoutRaw === "misaligned" ? "misaligned" : "unprobeable";
  if (layout === "unprobeable") {
    return { alias, layout, sync_state: "unknown", scheduler: "unknown", config: "unknown" };
  }
  const sync = (/SYNC:(.*)/.exec(stdout)?.[1] ?? "").trim();
  const schedRaw = /SCHED:(\S+)/.exec(stdout)?.[1];
  const scheduler: VaultScheduler =
    schedRaw === "loaded" ? "loaded" : schedRaw === "written-only" ? "written-only" : "unknown";
  const cfgRaw = /CONFIG:(\S+)/.exec(stdout)?.[1];
  const config: VaultConfigRes =
    cfgRaw === "resolved" ? "resolved"
    : cfgRaw === "foreign-home" ? "foreign-home"
    : cfgRaw === "absent" ? "absent"
    : "unknown";
  return { alias, layout, sync_state: sync === "" ? "unknown" : sync, scheduler, config };
}

/** One machine's vault health over the SSH mesh (M4) — the same injection pattern as
 *  sshProbe. A down machine is a parked row, never a failed digest. */
export function vaultHealthProbe(alias: string): VaultHealth {
  const r = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", alias, VAULT_PROBE_REMOTE],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (r.status !== 0) return parseVaultHealth(alias, "");
  return parseVaultHealth(alias, r.stdout || "");
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

  const aliases =
    machinesArg.trim() === "" ? null : machinesArg.split(",").map((a) => a.trim()).filter(Boolean);

  const machines: MachineProbe[] | null =
    aliases === null ? null : aliases.map((alias) => (deps.probe ? deps.probe(alias) : sshProbe(alias)));

  // Vault health is probed per machine through its own injectable probe (hermetic tests
  // never reach a real ssh); a machine alias list that is not configured means there is
  // nothing to probe — an honest n/a, never a silent pass.
  const vaults: VaultHealth[] | null =
    aliases === null ? null : aliases.map((alias) => (deps.vaultProbe ? deps.vaultProbe(alias) : vaultHealthProbe(alias)));

  const debt = deps.debt ?? MIGRATION_DEBT;

  const { records, unreadable } = readAllRecords(root);
  const view: DigestView = {
    date: new Date(now).toISOString().slice(0, 10),
    machines,
    vaults,
    sessions: summarizeSessions(records, unreadable.length, now),
    debt,
    ...(jobsLine !== undefined ? { jobsLine } : {}),
  };

  // The layout invariant is a FAILURE, not a warning (amico#361): a REACHABLE machine
  // whose two vault paths resolve to different storage fails the digest at exit 64 —
  // while the digest still renders (errors-as-data). A down machine is unprobeable and
  // stays parked; it never lands here.
  const layoutErrors = (vaults ?? [])
    .filter((vh) => vh.layout === "misaligned")
    .map(
      (vh) =>
        `vault layout misaligned on ${vh.alias}: ~/.amico/vaults and ~/armonia/data/vaults resolve to different storage (the M4 layout invariant)`,
    );
  // Config resolution is a FAILURE on a reachable machine (amico#361 AC): the found
  // incident was a Mac-shaped config synced to a Linux server — no path resolved.
  const configErrors = (vaults ?? [])
    .filter((vh) => vh.config === "foreign-home")
    .map(
      (vh) =>
        `distiller config foreign-home on ${vh.alias}: /Users/ paths survive on a non-Mac home (regenerate with armonia-distiller-config --write)`,
    );

  const block = formatDigestBlock(view);
  const table = formatDigestTable(view, root);

  const base: Record<string, unknown> = {
    verb: "fleet",
    subcommand,
    ok: layoutErrors.length === 0 && configErrors.length === 0,
    root,
    channel,
    machines: machines ?? [],
    vaults,
    migration_debt: debt,
    sessions: {
      total: view.sessions.total,
      live: view.sessions.live.length,
      byState: view.sessions.byState,
      unreadable: view.sessions.unreadable,
    },
    block,
    table,
    ...(layoutErrors.length > 0 || configErrors.length > 0 ? { errors: [...layoutErrors, ...configErrors] } : {}),
  };

  if (!isPost) {
    return { json: { ...base, dry_run: true }, code: layoutErrors.length === 0 && configErrors.length === 0 ? 0 : 64 };
  }

  const post = deps.post ?? postViaAmicoSlack;
  const res = post(channel, block, table);
  if (!res.ok) {
    return {
      json: { ...base, ok: false, dry_run: false, errors: [...layoutErrors, ...configErrors, ...(res.errors ?? ["post failed"])] },
      code: 64,
    };
  }
  return {
    json: { ...base, dry_run: false, posted: true, ...(res.ts ? { ts: res.ts } : {}), ...(res.warnings ? { warnings: res.warnings } : {}) },
    code: layoutErrors.length === 0 ? 0 : 64,
  };
}
