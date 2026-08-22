// ============================================================================
// Stack-state readers and builders — shared between the amicode_context.ts
// plugin and (eventually) the extension. Must use only node: builtins (fs,
// path, os) — imported by the Bun-runtime plugin via relative sibling import.
//
// Standalone copies of the reader logic from solver_mode.ts and routing.ts,
// minus the smol-toml dependency (not available in the plugin's Bun runtime),
// PLUS the live fleet line and the user-memory sections (profile, recent
// problems, reference demos, mount stack, memory index) — previously boot-time
// file splices, now read from the personal vault on every prompt build so a
// distiller write in the morning reaches the next message without a restart.
// Section text is pinned byte-for-byte by test/stack_state.test.ts (golden
// strings carried over from the retired substrate/user_splice.ts).
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

/** A run "solving" with no FINISHED marker this many hours after its
 *  timestamped id started is a ZOMBIE (crashed server, killed process) —
 *  report it as stale, never as live work. Run ids are rYYYYMMDD-HHMMSSZ-hash. */
const SOLVING_STALE_HOURS = 12;

/** Age in hours parsed from the run id's timestamp, else undefined. */
function runAgeHours(runName: string): number | undefined {
  const m = runName.match(/^r(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z-/);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(t)) return undefined;
  return (Date.now() - t) / 3_600_000;
}

/** Compact live-runs block: LIVE runs individually (with age), zombies called
 *  out as stale, and the finished backlog as ONE summary line (count + best
 *  F + latest). The full history lives in the runs dir — 120 individually
 *  listed finished runs drowned exactly the signal the greeting needs. */
function buildLiveRunsBlock(): string {
  const root = runsRoot();

  try {
    if (!fs.existsSync(root)) return "";

    const live: string[] = [];
    const stale: string[] = [];
    const done: { name: string; lab: string; fidelity: number | undefined }[] = [];

    const labs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const lab of labs) {
      const labDir = path.join(root, lab.name);
      const runs = fs.readdirSync(labDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const run of runs) {
        const runDir = path.join(labDir, run.name);
        const finished = fs.existsSync(path.join(runDir, "FINISHED"));
        let fidelity: number | undefined;
        let fidelityStr: string | undefined;
        const resultPath = path.join(runDir, "result.toml");
        if (fs.existsSync(resultPath)) {
          try {
            const content = fs.readFileSync(resultPath, "utf8");
            const m = content.match(/fidelity\s*=\s*([\d.eE+-]+)/);
            if (m) {
              fidelity = parseFloat(m[1]);
              fidelityStr = fidelity.toFixed(6);
            }
          } catch { /* skip */ }
        }
        if (finished) {
          done.push({ name: run.name, lab: lab.name, fidelity });
        } else {
          const ageH = runAgeHours(run.name);
          if (ageH !== undefined && ageH > SOLVING_STALE_HOURS) {
            const since = run.name.slice(1, 9).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
            stale.push(`- ${run.name} @ ${lab.name}: STALE — no FINISHED since ${since} (probably dead, do not present as live)`);
          } else {
            const age = ageH !== undefined ? (ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))}m` : `${Math.round(ageH)}h`) : "age unknown";
            live.push(`- ${run.name} @ ${lab.name}: solving (${age} old)`);
          }
        }
      }
    }

    const lines: string[] = [];
    if (live.length > 0 || stale.length > 0 || done.length > 0) {
      lines.push("**live runs**");
      lines.push(...live, ...stale);
      if (done.length > 0) {
        const best = done.reduce((acc, d) => (d.fidelity !== undefined && (acc === undefined || d.fidelity > acc) ? d.fidelity : acc), undefined);
        const withF = done.filter((d) => d.fidelity !== undefined);
        const latest = done[done.length - 1];
        const bits = [
          `${done.length} finished`,
          best !== undefined ? `best F=${best.toFixed(6)}` : null,
          withF.length > 0 ? `latest ${latest.name}${latest.fidelity !== undefined ? ` (F=${latest.fidelity.toFixed(6)})` : ""}` : null,
        ].filter(Boolean);
        lines.push(`- backlog: ${bits.join(" · ")} — full history in the runs dir`);
      }
    }
    return lines.length > 0 ? lines.join("\n") : "";
  } catch {
    return ""; // optional — silent on error
  }
}

// ── Fleet state ──────────────────────────────────────────────────────────────

function fleetConfigFile(override?: string): string {
  if (override) return override;
  const env = process.env.AMICO_FLEET_CONFIG;
  if (env && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".amico", "ops", "fleet", "fleet.json");
}

function fleetStatusFile(override?: string): string {
  if (override) return override;
  const env = process.env.AMICO_FLEET_STATUS;
  if (env && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".amico", "ops", "fleet-status.json");
}

/** Fleet role from fleet.json — "server" | "client" | "standalone".
 *  No file = null (a standalone machine has no fleet to report). */
function readFleetRole(configPath?: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fleetConfigFile(configPath), "utf8")) as Record<string, unknown>;
    return typeof parsed.role === "string" && parsed.role !== "" ? parsed.role : null;
  } catch {
    return null;
  }
}

interface FleetStatusSummary {
  total: number;
  up: number;
  names: string[];
  /** Minutes since collected_at, when parseable. */
  ageMin?: number;
}

function readFleetStatus(statusPath?: string): FleetStatusSummary | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(fleetStatusFile(statusPath), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.devices)) return undefined;
  const devices = obj.devices.filter(
    (d): d is Record<string, unknown> => typeof d === "object" && d !== null,
  );
  let ageMin: number | undefined;
  if (typeof obj.collected_at === "string") {
    const t = Date.parse(obj.collected_at);
    if (!Number.isNaN(t)) ageMin = Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  return {
    total: devices.length,
    up: devices.filter((d) => d.reachable === true).length,
    names: devices
      .map((d) => (typeof d.name === "string" ? d.name : ""))
      .filter((n) => n !== ""),
    ageMin,
  };
}

/** Lean fleet line + on-demand pointers (the reader's choice: detail loads
 *  from fleet-status.json / the fleet skill only when relevant). Absent
 *  fleet.json (standalone or no fleet tooling) → "" — nothing to say. */
function buildFleetSection(opts: { configPath?: string; statusPath?: string } = {}): string {
  const role = readFleetRole(opts.configPath);
  if (role === null) return "";

  const roleText =
    role === "server"
      ? "**server** — this machine is the canonical Amicode server"
      : role === "client"
        ? "**client** — rides the tunnel to the canonical server"
        : `**${role}**`;
  const lines = [`## Fleet (live)`, `Role: ${roleText} (\`~/.amico/ops/fleet/fleet.json\`).`];

  const status = readFleetStatus(opts.statusPath);
  if (status) {
    const who = status.names.length > 0 ? ` (${status.names.join(", ")})` : "";
    const age = status.ageMin !== undefined ? ` — refreshed ${status.ageMin} min ago` : "";
    lines.push(
      `Devices: ${status.up}/${status.total} reachable${who}${age} (launchd, 5-min cadence).`,
    );
  } else {
    lines.push("Devices: status unknown (`~/.amico/ops/fleet-status.json` unreadable).");
  }
  lines.push(
    "Full status on demand: `~/.amico/ops/fleet-status.json` (devices, chat-db health,",
    "server guard, repo sync). The `fleet` skill is the playbook for the sync/lock",
    "rituals; code repos sync by `wip-sync.sh` leave/arrive — never file-sync a live `.git`.",
  );
  return lines.join("\n");
}

// ── Armonia mount stack + user memory (live) ─────────────────────────────────
//
// Marker-only port of the extension's mount_store.ts discovery (same kind
// ranks, same skip rules) MINUS the mounts.toml manifest — smol-toml is not
// available in the plugin's Bun runtime. No manifest exists in practice today
// (kind-rank ordering is byte-equivalent); if one ever appears, the extension's
// full resolver at prep time remains canonical and this section degrades to a
// slightly stale ordering. Section text pinned by test/stack_state.test.ts.

interface LiveMount {
  name: string;
  kind: string;
  path: string;
  writable: boolean;
}

function vaultsRoot(override?: string): string {
  if (override) return override;
  const env = process.env.AMICO_VAULTS_ROOT;
  if (env && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".amico", "vaults");
}

/** Kind ranks + writable-by-default posture (vault-CLI spec-20260703-053956). */
function kindRank(kind: string): number {
  switch (kind) {
    case "personal":
      return 0;
    case "engagement":
      return 1;
    case "project":
      return 2;
    case "restricted":
      return 3;
    case "team":
      return 4;
    case "public":
      return 5;
    default:
      return 6;
  }
}

function writableByKind(kind: string): boolean {
  return kind === "personal" || kind === "project" || kind === "engagement";
}

/** Regex-lite marker parse — the markers carry only `kind` and `name`. */
function parseMarker(text: string): { kind?: string; name?: string } {
  const kind = text.match(/^\s*kind\s*=\s*"([^"]+)"\s*$/m);
  const name = text.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m);
  return { kind: kind?.[1], name: name?.[1] };
}

function discoverMounts(root?: string): { mounts: LiveMount[]; warnings: string[] } {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(vaultsRoot(root)).sort();
  } catch {
    return { mounts: [], warnings };
  }
  const discovered: LiveMount[] = [];
  const seen = new Set<string>();
  for (const base of entries) {
    const dir = path.join(vaultsRoot(root), base);
    let markerText: string;
    try {
      markerText = fs.readFileSync(path.join(dir, ".amico-vault.toml"), "utf8");
    } catch {
      continue; // marker-less dir: not a mount
    }
    const m = parseMarker(markerText);
    const kind = m.kind ?? "";
    const name = m.name && m.name !== "" ? m.name : base;
    if (kind === "") {
      warnings.push(`skipped '${base}': marker missing 'kind'`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`skipped '${base}': duplicate id '${name}'`);
      continue;
    }
    seen.add(name);
    discovered.push({ name, kind, path: dir, writable: writableByKind(kind) });
  }
  discovered.sort((a, b) => {
    const ra = kindRank(a.kind);
    const rb = kindRank(b.kind);
    if (ra !== rb) return ra - rb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { mounts: discovered, warnings };
}

/** The personal mount (first kind === "personal" in stack order), or undefined. */
function personalVaultDir(mounts: LiveMount[]): string | undefined {
  return mounts.find((m) => m.kind === "personal")?.path;
}

/** Non-empty PROFILE.md content, or "" (whitespace-only counts as absent). */
function readProfileMd(vaultDir: string): string {
  try {
    const text = fs.readFileSync(path.join(vaultDir, "amicode", "PROFILE.md"), "utf8");
    return text.trim() === "" ? "" : text;
  } catch {
    return "";
  }
}

/** List-item lines from an amicode index file, capped. */
function readIndexLines(vaultDir: string, file: string, cap: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(vaultDir, "amicode", file), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, cap);
}

/** Section builders — text pinned by test/stack_state.test.ts (golden strings). */

function buildAboutUserSection(profileMd: string): string {
  if (!profileMd) return "";
  return [
    "## About this user",
    "",
    profileMd.trim(),
    "",
    "Greet and recommend with this context. Anchor the hardware stage on the",
    "user's environment card (read it from the vault path above when you reach",
    "that stage). Never re-ask what the profile already answers.",
  ].join("\n");
}

function buildRecentProblemsSection(knowledgeLines: string[]): string {
  if (knowledgeLines.length === 0) return "";
  return [
    "## Your recent problems",
    "",
    ...knowledgeLines,
    "",
    "Before recommending parameters, check whether the user's target matches one",
    "of these cards (read the card file on demand for details). If a pulse exists",
    "in the bank, offer a warm start from its `pulse.jld2` path. If a prior",
    "attempt failed, surface its lesson before re-authoring.",
  ].join("\n");
}

function buildReferenceDemosSection(demoLines: string[]): string {
  if (demoLines.length === 0) return "";
  return [
    "## Reference demos",
    "",
    ...demoLines,
    "",
    "Curated demos we've built — use them as PRECEDENT (medium confidence) when",
    "the user's target matches one and there's no own-precedent card. Read the",
    "demo card on demand for its params, and cite it in your recommendation.",
  ].join("\n");
}

function buildMountStackSection(mounts: LiveMount[], warnings: string[]): string {
  if (mounts.length === 0) return "";
  const mountLines = mounts.map(
    (m) => `- ${m.name} · kind=${m.kind} · ${m.writable ? "rw" : "ro"} · ${m.path}`,
  );
  const warnLines = warnings.map((w) => `- ⚠ ${w}`);
  return [
    "## Mount stack (Armonia — read precedence top→bottom)",
    "",
    ...mountLines,
    ...warnLines,
    "",
    "Resolution & write-routing (condensed from the amico-vault skill):",
    "- Reads union across all mounts; on the same relative path the first hit",
    "  top→bottom wins (higher-precedence mount shadows lower).",
    "- Writes route by intent to the first WRITABLE mount of that kind:",
    "  personal→personal, engagement→engagement, project→project,",
    "  restricted/team/public→their own kind.",
    "- If the target mount is absent or read-only, write to the personal mount",
    "  and stamp `route_intent: <kind>` in the note frontmatter — never silently",
    "  drop a write, never write a ro mount.",
    "- Ambiguous intent: ask once, else default to personal.",
  ].join("\n");
}

function buildMemoryIndexSection(memoryIndexLines: string[]): string {
  if (memoryIndexLines.length === 0) return "";
  return [
    "## Memory index",
    "",
    ...memoryIndexLines,
    "",
    "These are one-line pointers. The full typed-memory cards (user / feedback /",
    "project / reference) load on demand from the granted vault path under",
    "`amicode/memory/` — read a card only when its hook is relevant to the turn.",
  ].join("\n");
}

// ── Public: compose the full per-session block ───────────────────────────────

/** Read the current stack state (solver mode, routing, active problem, live
 *  runs, fleet, and the personal-vault user-memory sections) and compose a
 *  markdown block to inject into the agent's system prompt. Returns null
 *  when nothing to report (no HP mode, no active problem, no runs, no fleet,
 *  no vault content). */
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

  const fleet = buildFleetSection();
  if (fleet) parts.push(fleet);

  // User-memory sections (live reads from the personal vault — splice order
  // parity with the retired boot-time file splice: about → recent → demos →
  // mount stack → memory index).
  const { mounts, warnings } = discoverMounts();
  const vault = personalVaultDir(mounts);
  if (vault) {
    const about = buildAboutUserSection(readProfileMd(vault));
    if (about) parts.push(about);
    const recent = buildRecentProblemsSection(readIndexLines(vault, "KNOWLEDGE.md", 50));
    if (recent) parts.push(recent);
    const demos = buildReferenceDemosSection(readIndexLines(vault, "DEMOS.md", 30));
    if (demos) parts.push(demos);
  }
  const mountSection = buildMountStackSection(mounts, warnings);
  if (mountSection) parts.push(mountSection);
  if (vault) {
    const memory = buildMemoryIndexSection(
      readIndexLines(vault, path.join("memory", "MEMORY.md"), 50),
    );
    if (memory) parts.push(memory);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
