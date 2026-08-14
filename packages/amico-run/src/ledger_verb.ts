// `amico ledger` — the run-ledger spine verb (Plan 3 / L1 Task 3). Two subverbs,
// both deterministic single-writer I/O against ~/.amico/ledger/runs.jsonl (or
// $AMICO_LEDGER). Registering ONE Verb in SPINE_VERBS yields CLI dispatch, the MCP
// facade, and --help for free (mirrors catalog_verb.ts / note_verb.ts).
//
//   amico ledger append  [--json <stanza> | (stdin)]
//       → validate a record against the ledger-record schema (Task 2) and append it
//         as one JSONL line. The SINGLE-WRITER discipline: the extension NEVER
//         writes runs.jsonl directly — it shells THIS verb. Malformed / schema-
//         invalid stanzas are rejected (nonzero) so the ledger stays honest.
//
//   amico ledger query   --structure-hash <h> --n <N> --t <T>
//                        [--goal <g>]
//                        [--platform <p> --template <t> --trajectory <t> --levels <n>]
//       → honest priors at `structure_hash × goal × (N-bucket, T-bucket)`: medians+IQR,
//         "n runs, m verified" provenance, and interim-capped confidence. The
//         optional fallback key parts relax the query when the primary is sparse.
//         `--goal` is what keeps a CZ's medians out of an X gate's bucket —
//         `structure_hash` covers the type skeleton, NOT the task. Omitting it is
//         allowed and coarse, and the provenance string reports which you got.
//         Delegates to ledger_query.ts (Task 4).
//

//   amico ledger claim --work-id <id> --agent-id <a> --user <u> --org <o> --host <h> [--variant-axis <v>] [--ttl <s>]
//       → coordination preflight Claim (spec #318 §3): Dedup→Claim→Warrant gate before any dispatch.
//         Serializes on work_id via server time, returns holder on conflict with yield/steer/variant menu.
//   amico ledger dispatch --work-id <id> --task-type <t>
//                         [--variant <v>] [--stamp <model>] [--include-simulated]
//       → the tier-dispatch table (fleet §6.3 Rev 5): per-(model, variant) cells with
//         first-attempt pass rates, m*(s) = argmin c_m/p_m(s), and the escalation
//         ladder as the standing fallback. Delegates to ledger_dispatch.ts. Simulated
//         evidence is opt-in and lands in the SIM LANE ONLY — it never widens a
//         hardware cell.
//
//   amico ledger approve --plan-hash <h> [--max-solves <n>] [--tier <t>]
//                        [--max-size-class SMALL|MEDIUM] [--device none|ro|rw]
//                        [--expires-in <s>] [--issued-by <who>]
//       → mint a capability warrant (spec-20260727-164748 §5): the record that lets a
//         gated launch through the --spec gate. This is the transport the approval
//         card requires (spec §9.5) — an approval must reach the ledger DIRECTLY,
//         never as a chat message the agent interprets and then records, or the
//         provenance reads "the agent says the user approved". Bounds are written
//         ONLY as declared: an omitted bound is ABSENT, never defaulted, because
//         §5.1 rule 2 refuses a launch needing a bound the warrant omits — so a
//         helpfully-filled default would silently widen the warrant.
import { readFileSync } from "node:fs";
import { appendRecord, type ApprovalRecord, type LedgerRecord, type WarrantBounds } from "./ledger.js";
import { bucketN, bucketT, queryDefaults, type QueryKey } from "./ledger_query.js";
import { dispatchTable, type DispatchKey } from "./ledger_dispatch.js";
import type { VerbResult } from "./verbs.js";

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Read the append stanza: `--json <string>`, else stdin (fd 0). Never blocks a
 *  TTY — stdin is only read when no `--json` was given AND input is piped. */
function readStanza(argv: string[]): string | undefined {
  const inline = flagValue(argv, "--json");
  if (inline !== undefined) return inline;
  if (process.stdin.isTTY) return undefined; // interactive — no piped stanza
  try {
    return readFileSync(0, "utf8");
  } catch {
    return undefined;
  }
}

// ── append ────────────────────────────────────────────────────────────────────
export function ledgerAppend(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "ledger", subcommand: "append", error }, code: 64 });

  const stanza = readStanza(argv);
  if (stanza === undefined || stanza.trim().length === 0) {
    return fail("an append stanza is required: --json <record> or a piped JSON record on stdin");
  }

  let rec: LedgerRecord;
  try {
    rec = JSON.parse(stanza) as LedgerRecord;
  } catch (e) {
    return fail(`could not parse stanza as JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    appendRecord(rec); // validates against the ledger-record schema; throws on invalid / oversize
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  return { json: { verb: "ledger", subcommand: "append", ok: true, type: rec.type }, code: 0 };
}

// ── query ─────────────────────────────────────────────────────────────────────
export function ledgerQuery(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "ledger", subcommand: "query", error }, code: 64 });

  const structure_hash = flagValue(argv, "--structure-hash");
  const nRaw = flagValue(argv, "--n");
  const tRaw = flagValue(argv, "--t");
  if (!structure_hash || nRaw === undefined || tRaw === undefined) {
    return fail("--structure-hash, --n, and --t are required");
  }
  const n = Number(nRaw);
  const t = Number(tRaw);
  if (!Number.isFinite(n) || !Number.isFinite(t)) return fail("--n and --t must be numbers");

  const levelsRaw = flagValue(argv, "--levels");
  const key: QueryKey = {
    structure_hash,
    n_bucket: bucketN(n),
    t_bucket: bucketT(t),
    // structure_hash does not cover the goal, so pass it to keep CZ priors out of
    // an X-gate bucket. Omitting it is honest-but-coarse and provenance says so.
    goal: flagValue(argv, "--goal"),
    platform: flagValue(argv, "--platform"),
    template: flagValue(argv, "--template"),
    trajectory: flagValue(argv, "--trajectory"),
    levels: levelsRaw !== undefined && Number.isFinite(Number(levelsRaw)) ? Number(levelsRaw) : undefined,
  };

  const result = queryDefaults(key);
  return { json: { verb: "ledger", subcommand: "query", ...result }, code: 0 };
}

// ── dispatch (tier dispatch, fleet §6.3) ─────────────────────────────────────
export function ledgerDispatch(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "ledger", subcommand: "dispatch", error }, code: 64 });

  const work_id = flagValue(argv, "--work-id");
  const task_type = flagValue(argv, "--task-type");
  if (!work_id || !task_type) return fail("--work-id and --task-type are required");

  const key: DispatchKey = {
    work_id,
    task_type,
    variant: flagValue(argv, "--variant"),
    stamp: flagValue(argv, "--stamp"),
  };
  const result = dispatchTable(key, {
    include_simulated: argv.includes("--include-simulated"),
    frontier: flagValue(argv, "--frontier"),
  });
  return { json: { verb: "ledger", subcommand: "dispatch", ...result }, code: 0 };
}

// ── approve (capability warrant, spec-20260727-164748 §5) ────────────────────
/** A positive integer flag, or a typed refusal. Rejects rather than coercing: a
 *  silently-floored `--max-solves 1.5` would write a bound nobody asked for. */
function positiveInt(raw: string | undefined, name: string): number | string | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return `${name} must be a positive integer (got "${raw}")`;
  return n;
}


export async function ledgerClaim(argv: string[]): Promise<VerbResult> {
  const fail = (error: string): VerbResult => ({ json: { verb: "ledger", subcommand: "claim", error }, code: 64 });
  const work_id = argv.includes("--work-id") ? argv[argv.indexOf("--work-id")+1] : undefined;
  const agent_id = argv.includes("--agent-id") ? argv[argv.indexOf("--agent-id")+1] : undefined;
  const user = argv.includes("--user") ? argv[argv.indexOf("--user")+1] : undefined;
  const org = argv.includes("--org") ? argv[argv.indexOf("--org")+1] : undefined;
  const host = argv.includes("--host") ? argv[argv.indexOf("--host")+1] : undefined;
  if (!work_id || !agent_id || !user || !org || !host) return fail("--work-id --agent-id --user --org --host are required");
  const { preflight } = await import("./coordination_preflight.js");
  // Derive structure_hash from work_id for preflight — for CLI, treat work_id as structure_hash + goal split
  const res = await preflight({ structure_hash: work_id, goal: "claim", N: 100, T: 30, agent_id, user, org, host });
  return { json: { verb: "ledger", subcommand: "claim", work_id, ...res }, code: 0 };
}

export function ledgerApprove(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({ json: { verb: "ledger", subcommand: "approve", error }, code: 64 });

  const plan_hash = flagValue(argv, "--plan-hash");
  if (!plan_hash) return fail("--plan-hash is required (what is being approved)");

  // Bounds are declared-only. An omitted key stays ABSENT so the gate's §5.1
  // rule 2 refusal applies; defaulting any of these would widen the warrant.
  const bounds: WarrantBounds = {};

  const maxSolves = positiveInt(flagValue(argv, "--max-solves"), "--max-solves");
  if (typeof maxSolves === "string") return fail(maxSolves);
  if (maxSolves !== undefined) bounds.max_solves = maxSolves;

  const sizeClass = flagValue(argv, "--max-size-class");
  if (sizeClass !== undefined) {
    if (sizeClass !== "SMALL" && sizeClass !== "MEDIUM")
      return fail(`--max-size-class must be SMALL|MEDIUM (got "${sizeClass}")`);
    bounds.max_size_class = sizeClass;
  }

  const tier = flagValue(argv, "--tier");
  if (tier !== undefined) bounds.tier = tier;

  const device = flagValue(argv, "--device");
  if (device !== undefined) {
    if (device !== "none" && device !== "ro" && device !== "rw")
      return fail(`--device must be none|ro|rw (got "${device}")`);
    bounds.device = device;
  }

  const expiresIn = positiveInt(flagValue(argv, "--expires-in"), "--expires-in");
  if (typeof expiresIn === "string") return fail(expiresIn);
  const ttl = expiresIn ?? 3600; // one hour — short by design; §5 leans session-scoped

  const now = new Date();
  const rec: ApprovalRecord = {
    type: "approval",
    ts: now.toISOString(),
    plan_hash,
    bounds,
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    // Never empty: an unattributed warrant is worse than none, since the ledger's
    // only provenance for who approved is this field.
    issued_by: flagValue(argv, "--issued-by") ?? "user:cli",
  };

  try {
    appendRecord(rec); // single writer (#212) — never a second append path
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return {
    json: {
      verb: "ledger",
      subcommand: "approve",
      ok: true,
      plan_hash,
      bounds,
      expires_at: rec.expires_at,
    },
    code: 0,
  };
}

// ── subcommand router ────────────────────────────────────────────────────────
/** The `ledger` verb body: route on the subcommand. Backs BOTH the CLI
 *  (amico.ts) and the MCP facade (mcp_serve.ts). */
export function ledgerVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "append") return ledgerAppend(rest);
  if (sub === "query") return ledgerQuery(rest);
  if (sub === "dispatch") return ledgerDispatch(rest);
  if (sub === "approve") return ledgerApprove(rest);
  return {
    json: {
      verb: "ledger",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage:
        "amico ledger append [--json <record> | (stdin)]  |  amico ledger query --structure-hash <h> --n <N> --t <T> [--goal <g> --platform <p> --template <t> --trajectory <t> --levels <n>]  |  amico ledger dispatch --work-id <id> --task-type <t> [--variant <v>] [--stamp <model>] [--include-simulated]  |  amico ledger approve --plan-hash <h> [--max-solves <n>] [--tier <t>] [--max-size-class SMALL|MEDIUM] [--device none|ro|rw] [--expires-in <s>] [--issued-by <who>]",
    },
    code: 64,
  };
}
