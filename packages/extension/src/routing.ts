import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Δ10 (#63) — the per-solve routing UX decision core.
//
// Routing (CONTEXT.md glossary): the PER-SOLVE, explicit choice of where one
// solve executes — local or Company Compute. Informed by the Estimate; always
// user-confirmed, never automatic. This module never routes: it (a) reads
// whether Company Compute is currently connected (the gate for OFFERING remote
// routing) and (b) shapes the routing guidance spliced into the agent's
// AGENTS.md so the "run on company compute?" confirm is estimator-informed and
// always explicit.
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

/** The routing-UX guidance spliced into the agent's AGENTS.md (#63). It shapes
 *  the per-solve "run on company compute?" CONFIRM: the Estimate (amico-run
 *  estimate) SUGGESTS a default, the researcher always confirms, nothing
 *  auto-routes. The remote OFFER renders ONLY when Company Compute is connected
 *  AND the solver mode is hp (the entitlement) — otherwise this returns "",
 *  leaving the AGENTS.md default (local, explicit) untouched, so piccolo /
 *  disconnected sessions stay byte-identical to before. */
export function buildRoutingSection(ctx: RoutingContext): string {
  if (!ctx.connected || ctx.solverMode !== "hp") return "";
  const who = ctx.identity ? ` (connected as ${ctx.identity})` : "";
  return (
    "\n\n## Routing (where THIS solve runs)\n" +
    `Company compute is connected${who}, so a solve may run LOCAL or on company compute. ` +
    "Routing is PER-SOLVE and EXPLICIT — you confirm where EVERY solve runs and never " +
    "auto-route (key entry never routes a solve; a large estimate never routes a solve).\n" +
    "- **Estimate first, at the decision point.** Before assembling the SolveSpec run " +
    "`amico-run estimate <solve.jl>` (or `--spec <solvespec.json>`) and read its one JSON " +
    "line `{sizeClass, estimatedBytes, localRamBytes, offloadSuggested, reason, …}`. Show " +
    "the researcher the `sizeClass`, the human-readable `estimatedBytes` vs local RAM, and " +
    "the `reason`.\n" +
    "- **The estimate only SUGGESTS.** When `offloadSuggested` is true, DEFAULT the confirm " +
    "to company compute (the solve is estimated to exceed local RAM); otherwise default to " +
    "local. Either way, ASK — the researcher's answer decides, every solve.\n" +
    "- **Carry the choice on the SolveSpec.** On explicit confirmation of company compute set " +
    '`executor: "remote"` in solvespec.json; otherwise `executor: "local"`. Setting `executor` ' +
    "is all routing does here — the downstream run path is executor-agnostic."
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
