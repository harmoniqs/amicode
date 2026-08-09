// ============================================================================
// Stack-state readers and builders — shared between the amicode_context.ts
// plugin and (eventually) the extension. Must use only node: builtins (fs,
// path, os) — imported by the Bun-runtime plugin via relative sibling import.
//
// Standalone copies of the reader logic from solver_mode.ts and routing.ts,
// minus the smol-toml dependency (not available in the plugin's Bun runtime).
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Solver mode ──────────────────────────────────────────────────────────────

function solverModeFile(): string {
  const opsDir = process.env.AMICODE_OPS_DIR;
  if (opsDir && opsDir.trim() !== "") return path.join(opsDir.trim(), "solver-mode.json");
  return path.join(os.homedir(), ".amico", "amicode", "solver-mode.json");
}

function readSolverModeState(): { mode: "piccolo" | "hp"; status: "ready" | "switching" } {
  try {
    const parsed = JSON.parse(fs.readFileSync(solverModeFile(), "utf8")) as Record<string, unknown>;
    return {
      mode: parsed.mode === "hp" ? "hp" : "piccolo",
      status: parsed.status === "switching" ? "switching" : "ready",
    };
  } catch {
    return { mode: "piccolo", status: "ready" };
  }
}

// ── Cloud connection status ──────────────────────────────────────────────────

function connectionsStatusFile(): string {
  const env = process.env.AMICODE_CONNECTIONS_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "connections.json");
}

function readCompanyComputeStatus(): { connected: boolean; identity?: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(connectionsStatusFile(), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { connected: false };
    const obj = raw as Record<string, unknown>;
    let entry: Record<string, unknown> | undefined;
    if (Array.isArray(obj.connections)) {
      entry = obj.connections.find(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null && (c as Record<string, unknown>).id === "company-compute",
      );
    } else if (typeof obj["company-compute"] === "object" && obj["company-compute"] !== null) {
      entry = obj["company-compute"] as Record<string, unknown>;
    }
    if (!entry) return { connected: false };
    const identity = typeof entry.identity === "string" && entry.identity !== "" ? entry.identity : undefined;
    return { connected: entry.state === "connected", ...(identity ? { identity } : {}) };
  } catch {
    return { connected: false };
  }
}

// ── Active problem ───────────────────────────────────────────────────────────

function problemsRoot(): string {
  const env = process.env.AMICODE_PROBLEMS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "problems");
}

function activeProblemSlug(): string | undefined {
  try {
    const activeFile = path.join(problemsRoot(), "active");
    if (!fs.existsSync(activeFile)) return undefined;
    const slug = fs.readFileSync(activeFile, "utf8").trim();
    if (!slug) return undefined;
    const dir = path.join(problemsRoot(), slug);
    return fs.existsSync(dir) ? slug : undefined;
  } catch {
    return undefined;
  }
}

function readEntityJson<T>(slug: string, kind: string): T | undefined {
  try {
    const file = path.join(problemsRoot(), slug, "entities", `${kind}.json`);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ── Live runs ────────────────────────────────────────────────────────────────

function runsRoot(): string {
  const env = process.env.AMICODE_RUNS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "runs");
}

// ── Section builders ─────────────────────────────────────────────────────────

/** Full solver-mode guidance section (Altissimo gotchas, import-both warning,
 *  routing sub-text). Mirrors opencode_config.ts solverModeSection() text. */
function buildSolverModeSection(): string {
  const state = readSolverModeState();
  if (state.mode !== "hp") return "";

  const status = readCompanyComputeStatus();
  const connected = status.connected;
  const routing = connected
    ? "Harmoniqs Cloud is CONNECTED, and EVERY solve on this solver runs there — this tier has no local " +
      "mode, so never ask the user where a solve should run. Author it as: " +
      '`tier="hpc"`, `executor="remote"`, `env.kind="provisioned"` (via `amico-run --spec <spec> ' +
      "<script.jl> --executor remote`). The runner image has Piccolissimo/Altissimo pre-baked, so there " +
      "is NO local precompile and NO sandbox — never author a sandbox env for HP. A local launch is " +
      "REFUSED by amico-run while this solver is selected (exit 64), so attempting one only wastes a turn. " +
      "Live iteration frames stream to the Inspector; note that per-iteration AMICODE_ITER stats + the " +
      "cooperative Stop are not yet available on the cloud bundle, and re-rollout verification is skipped " +
      "for cloud runs (say so). Only claim cloud execution when the launch actually used `--executor remote`."
    : "Harmoniqs Cloud is NOT connected (no API key). Piccolissimo + Altissimo is a PAID cloud tier and " +
      "CANNOT run locally — do NOT attempt a local Piccolissimo solve (it will fail three ways: amico-run " +
      "refuses a local launch in this mode, the private package can't be instantiated in a sandbox, and " +
      "the gate rejects a local hpc run). Instead, STOP and tell the user: " +
      '"Piccolissimo + Altissimo needs a Harmoniqs Cloud connection — click **Piccolissimo + Altissimo** ' +
      "in the model · solver control on the dashboard and connect your API key there (or run **Amico: " +
      'Connect Cloud**, which opens the same flow)." Offer to switch back to the free local Piccolo solver ' +
      "if they'd rather not connect now.";

  return (
    "## Solver mode\n" +
    "**HIGH-PERFORMANCE + CLOUD (Piccolissimo + Altissimo).** The user selected the paid " +
    '"High-Performance + Cloud" solver. Author solves with the **Piccolissimo** stack ' +
    "(SplinePulseProblem, free-phase paths, `using Piccolissimo`) rather than plain Piccolo, falling back " +
    "to Piccolo only when Piccolissimo cannot express the problem (say so when you do). " +
    "**Import BOTH: `using Piccolo` AND `using Piccolissimo`.** Piccolissimo does NOT re-export Piccolo's " +
    "symbols, so a script with only `using Piccolissimo` dies on the first `GATES[:X]`, `TransmonSystem`, " +
    "`EmbeddedOperator`, `UnitaryTrajectory` — every problem-setup name comes from Piccolo. The failure is " +
    "an UndefVarError at load time, before any solve starts, and on a cloud run you pay the full queue and " +
    "instance-boot wait before seeing it. " +
    "**Solver backend:** the default remains IPOPT (`IpoptOptions`), which is what streams per-iteration " +
    "telemetry — its `intermediate_callback` produces the Inspector's frames and the `AMICODE_ITER` lines. " +
    "If the researcher asks for the **Altissimo** backend (the augmented-Lagrangian GPU solver, " +
    "`AltissimoOptions`), switch it by setting **`SOLVER = :altissimo`** in the template's FILL-IN block — that " +
    "one line is the whole change. Do NOT hand-roll the solve call: the template already re-hangs BOTH telemetry " +
    "channels onto Altissimo's `(x, info)` hook (the frames come off `IpoptOptions.intermediate_callback`, which " +
    "`AltissimoOptions` does not have, so a hand-written call loses the Inspector's frames as well as its " +
    "numbers), passes the budget as `AltissimoOptions(max_outer_iter = max_iter)` (a `max_iter` given to " +
    "`solve!` is silently DROPPED on that path — the solve would quietly run 20 outer iterations), and derives " +
    "`inf_pr`/`inf_du` on older Altissimo builds. " +
    "Also TELL THEM that live iterations depend on the INSTALLED version. " +
    "Current Piccolissimo main accepts a `callback` on `solve!(::AltissimoOptions)` and forwards it to " +
    "`Altissimo.optimize!`, which fires it every outer iteration; older builds swallow `kwargs...` and forward " +
    "nothing, so an Altissimo run there emits NO AMICODE_ITER lines and the Run Inspector stays dark until the " +
    "solve finishes. Do not promise live iterations you have not seen: run it, and if no AMICODE_ITER line " +
    "appears in the first iterations, say so plainly rather than implying the solve is stuck. Never switch to " +
    "Altissimo silently. " +
    routing
  );
}

/** Full routing guidance section. Mirrors routing.ts buildRoutingSection text. */
function buildRoutingSection(): string {
  const state = readSolverModeState();
  const status = readCompanyComputeStatus();

  if (!status.connected || state.mode !== "hp") return "";

  const who = status.identity ? ` (connected as ${status.identity})` : "";
  return (
    "## Routing (where THIS solve runs)\n" +
    `Harmoniqs Cloud is connected${who} and the selected solver is **Piccolissimo + Altissimo**, ` +
    "which is a CLOUD-ONLY tier. Every solve on this solver runs in the cloud: there is no " +
    "local-vs-cloud choice to make here, so do NOT ask the researcher where it should run.\n" +
    "- **Author it as High-Performance + Cloud.** Set `tier=\"hpc\"`, `executor=\"remote\"`, and " +
    '`env.kind="provisioned"` on solvespec.json, then launch with `amico-run --spec <spec> ' +
    "<script.jl> --executor remote`.\n" +
    "- **Never dispatch this solver locally.** The runner image has Piccolissimo/Altissimo " +
    "pre-baked; a laptop would precompile the HP stack from scratch. amico-run REFUSES a local " +
    "launch while this solver is selected (exit 64), so a local attempt only wastes a turn.\n" +
    "- **`amico-run estimate` is still worth running** to report size and cost to the " +
    "researcher, but it no longer decides anything: an estimate that fits in local RAM does " +
    "not make an HP solve local.\n" +
    "- **A local solve means switching solvers.** If the researcher wants to run locally, they " +
    "switch the solver to Piccolo (the model · solver control) — that is a user action, not " +
    "something you can do for them by setting `executor: \"local\"`. "
  );
}

/** Compact active-problem block: one line showing slug + entity presence. */
function buildActiveProblemBlock(): string {
  const slug = activeProblemSlug();
  if (!slug) return "";

  const sys = readEntityJson<Record<string, unknown>>(slug, "system");
  const form = readEntityJson<Record<string, unknown>>(slug, "formulation");
  const hasSys = !!sys;
  const hasForm = !!form;

  if (!hasSys && !hasForm) return `active problem: **${slug}** (no entities recorded yet)`;

  let desc = `active problem: **${slug}** —`;
  if (hasSys) desc += " system ✓";
  if (hasForm) {
    const f = form as Record<string, string>;
    const target = f.target ?? "?";
    const traj = f.trajectory_type ?? "?";
    const parts = [target, traj];
    if (f.time_mode === "min_time") parts.push("min-time");
    if (f.free_phase) parts.push("free-phase");
    desc += `, formulation ✓ (${parts.join(" · ")})`;
  }
  return desc;
}

/** Compact live-runs block: one-line-per-run with status. */
function buildLiveRunsBlock(): string {
  const root = runsRoot();
  const lines: string[] = [];

  try {
    if (!fs.existsSync(root)) return "";

    const labs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const lab of labs) {
      const labDir = path.join(root, lab.name);
      const runs = fs.readdirSync(labDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const run of runs) {
        const runDir = path.join(labDir, run.name);
        const solved = !fs.existsSync(path.join(runDir, "FINISHED"));
        let fidelity: string | undefined;
        const resultPath = path.join(runDir, "result.toml");
        if (fs.existsSync(resultPath)) {
          try {
            const content = fs.readFileSync(resultPath, "utf8");
            const m = content.match(/fidelity\s*=\s*([\d.eE+-]+)/);
            if (m) fidelity = parseFloat(m[1]).toFixed(6);
          } catch { /* skip */ }
        }
        const status = solved ? "solving" : fidelity ? `done (F=${fidelity})` : "done";
        lines.push(`- ${run.name} @ ${lab.name}: ${status}`);
      }
    }
  } catch {
    return ""; // optional — silent on error
  }

  return lines.length > 0 ? "**live runs**\n" + lines.join("\n") : "";
}

// ── Public: compose the full per-session block ───────────────────────────────

/** Read the current stack state (solver mode, routing, active problem, live
 *  runs) and compose a markdown block to inject into the agent's system prompt.
 *  Returns null when nothing to report (no HP mode, no active problem, no runs). */
export function buildStackStateBlock(): string | null {
  const parts: string[] = [];

  const solver = buildSolverModeSection();
  if (solver) parts.push(solver);

  const routing = buildRoutingSection();
  if (routing) parts.push(routing);

  const active = buildActiveProblemBlock();
  const runs = buildLiveRunsBlock();
  if (active || runs) {
    const lines = [active, runs].filter(Boolean).join("\n");
    if (lines) parts.push("## Stack state (live)\n" + lines);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
