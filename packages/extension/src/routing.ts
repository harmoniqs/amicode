import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Δ10 (#63) — the routing UX decision core.
//
// Routing (CONTEXT.md glossary): where one solve executes — local or Harmoniqs
// Cloud. The choice is made by the SOLVER SELECTION, not per solve: Piccolo is
// local, and Piccolissimo + Altissimo is a paid cloud-only tier whose solves
// always run in the cloud. Selecting a solver is the user's explicit act, so
// nothing here is "automatic routing" in the sense #63 forbade — the decision
// simply moved from a per-solve prompt to the solver control, which is where
// users actually expressed it (2026-07-28: a per-solve confirm alongside a
// cloud-only tier read as a contradiction and the agent kept dispatching HP
// locally).
//
// This module never routes: it (a) reads whether Harmoniqs Cloud is currently
// connected and (b) shapes the routing guidance spliced into the agent's
// AGENTS.md. The durable enforcement is elsewhere and does not trust this prose
// — amico-run refuses a local launch while HP is selected, and its gate refuses
// a tier=hpc spec that is not remote + provisioned + connected.
//
// SECURITY: the cloud token lives in ~/.amico/cloud.json and is NEVER read here
// — UI code reads STATUS only (design constraint). The status comes from the
// connections seam's NON-SECRET cache (the same data GET /amicode/connections
// serves), and every parser whitelists exactly the two string fields it needs,
// so a poisoned cache entry can never leak a token into the agent's context.
// Reading status is not re-validating: no probe is ever fired from here.
// ============================================================================

/** The one Company Compute connection id — matches CLOUD_CONNECTION_ID
 *  (cloud_key.ts) and the fork's CONNECTION_IDS. */
export const COMPANY_COMPUTE_ID = "company-compute";

export interface CompanyComputeStatus {
  /** The Company Compute connection exists right now (state === "connected" in
   *  the status route/cache) — the gate for OFFERING remote routing (#63: only
   *  when the connection exists). Never derived by re-validating, never from a
   *  token; a disconnected-but-still-HP session reads connected:false here. */
  connected: boolean;
  /** The "connected as <submitter>" identity echo, when the status carries one
   *  (the immutable join key; submitter-drift incident 2026-07-19). */
  identity?: string;
}

/** Where the fork's connections seam persists its NON-SECRET status cache — the
 *  same data GET /amicode/connections serves, minus the token. Resolution
 *  mirrors the fork's connectionsFile() EXACTLY ($AMICODE_CONNECTIONS_FILE →
 *  ~/.amico/connections.json) so we read precisely what it wrote. */
export function connectionsStatusFile(): string {
  const env = process.env.AMICODE_CONNECTIONS_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "connections.json");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Extract the Company Compute status from EITHER the cache-file shape
 *  (`{ "company-compute": {state, identity} }`) or a status-route body
 *  (`{ connections: [{id, state, identity}] }`). Only `state` and `identity`
 *  are ever read — a token or any other key has no path into the output. */
export function parseCompanyComputeStatus(raw: unknown): CompanyComputeStatus {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { connected: false };
  const obj = raw as Record<string, unknown>;
  let entry: Record<string, unknown> | undefined;
  if (Array.isArray(obj.connections)) {
    entry = obj.connections.find(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && (c as Record<string, unknown>).id === COMPANY_COMPUTE_ID,
    );
  } else if (typeof obj[COMPANY_COMPUTE_ID] === "object" && obj[COMPANY_COMPUTE_ID] !== null) {
    entry = obj[COMPANY_COMPUTE_ID] as Record<string, unknown>;
  }
  if (!entry) return { connected: false };
  const identity = str(entry.identity);
  return { connected: entry.state === "connected", ...(identity ? { identity } : {}) };
}

/** Read the current Company Compute connection status from the non-secret
 *  status cache. Any trouble (absent / corrupt / unreadable) fails SAFE to
 *  not-connected — the routing offer falls back to local-only, never a throw
 *  and never a false "connected". */
export function readCompanyComputeStatus(file: string = connectionsStatusFile()): CompanyComputeStatus {
  try {
    return parseCompanyComputeStatus(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { connected: false };
  }
}

export interface RoutingContext {
  /** The current Solver mode (the entitlement half): remote routing is offered
   *  only in `hp` — a valid Company Compute key flips mode to hp. */
  solverMode: "piccolo" | "hp";
  /** Whether the Company Compute connection exists right now (the connection
   *  half): flip is one-way, so mode alone is not enough — a disconnected
   *  hp-mode session must NOT be offered remote routing. */
  connected: boolean;
  identity?: string;
}

/** The routing guidance spliced into the agent's AGENTS.md (#63). It states the
 *  one fact the agent needs: this solver is cloud-only, so author `tier="hpc"`
 *  + `executor="remote"` and never ask where the solve should run. It renders
 *  ONLY when Harmoniqs Cloud is connected AND the solver mode is hp (the
 *  entitlement) — otherwise "", leaving the AGENTS.md default (local, explicit)
 *  untouched, so piccolo / disconnected sessions stay byte-identical to before.
 *
 *  Both halves are still required: the mode flip is one-way, so a disconnected
 *  hp session must not be told the cloud is available — it gets the
 *  block-with-prompt copy from solverModeSection() instead. */
export function buildRoutingSection(ctx: RoutingContext): string {
  if (!ctx.connected || ctx.solverMode !== "hp") return "";
  const who = ctx.identity ? ` (connected as ${ctx.identity})` : "";
  return (
    "\n\n## Routing (where THIS solve runs)\n" +
    `Harmoniqs Cloud is connected${who} and the selected solver is **Piccolissimo + Altissimo**, ` +
    "which is a CLOUD-ONLY tier. Every solve on this solver runs in the cloud: there is no " +
    "local-vs-cloud choice to make here, so do NOT ask the researcher where it should run.\n" +
    "- **Author it as High-Performance + Cloud.** Set `tier=\"hpc\"`, `executor=\"remote\"`, and " +
    '`env.kind="provisioned"` on solvespec.json, then launch with `amico-run --spec <spec> ' +
    "<script.jl> --executor remote`.\n" +
    "- **Never dispatch this solver locally.** The runner image has Piccolissimo/Altissimo " +
    "pre-baked; a laptop would precompile the HP stack from scratch. amico-run routes this tier " +
    "to the cloud on its own — a launch with no `--executor` is promoted to remote — and it " +
    "REFUSES an explicit `--executor local` (exit 64), so a local attempt only wastes a turn.\n" +
    "- **`amico-run estimate` is still worth running** to report size and cost to the " +
    "researcher, but it no longer decides anything: an estimate that fits in local RAM does " +
    "not make an HP solve local.\n" +
    "- **A local solve means switching solvers.** If the researcher wants to run locally, they " +
    "switch the solver to Piccolo (the model · solver control) — that is a user action, not " +
    "something you can do for them by setting `executor: \"local\"`."
  );
}

/** Assemble the routing context for a session from the live solver mode and the
 *  connections status cache (both token-free). Thin composition seam so
 *  opencode_config.ts stays a one-liner and the readers stay independently
 *  testable. */
export function readRoutingContext(
  solverMode: "piccolo" | "hp",
  statusFile: string = connectionsStatusFile(),
): RoutingContext {
  const status = readCompanyComputeStatus(statusFile);
  return { solverMode, connected: status.connected, ...(status.identity ? { identity: status.identity } : {}) };
}
