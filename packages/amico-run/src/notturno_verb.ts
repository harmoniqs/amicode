// `amico notturno` — the TS-native notturno verb (amicode #1669, the #852
// step-6 A1′ leg): the scheduled-agentic-work vocabulary — register · warrant
// · run-a-pass · record — as public CLI surface. Parity over rewrite: the
// registry-check verdicts and the pass records are the Python engine's
// (amicissimo automation/notturno, post-#490), and the two runners coexist
// against the same registry file during the boundary window.
//
// Exit classes (the Python engine's codes where observable; deny = the
// briefing's 64 class): 0 ok, 1 coverage drift, 2 registry/manifest data
// errors, 64 usage + THE DENY GATE. The deny gate fires BEFORE the registry
// parses — org config is never even read, never silently run: a registry
// named by an instance-deny-list row fails loudly with the named reason,
// pointing at the private instance's runner.
//
// A public binary ships no default registry (the Harmoniqs registry is
// instance data): --registry or AMICO_NOTTURNO_REGISTRY, always.
import type { VerbResult } from "./verbs.js";
import { coverage, deniedBy, discoverDenyList, discoverWorkflowsDir, loadDenyList, loadRegistry } from "./notturno_registry.js";
import { PASS_STATUSES, appendSection, renderPass } from "./notturno_passes.js";

const USAGE = [
  "amico notturno registry-check [--registry <p>] [--workflows-dir <d>] [--deny-list <p>]",
  "amico notturno list [--registry <p>] [--deny-list <p>]",
  "amico notturno pass --job <j> --status <ok|failed> --outcome <t> [--duration-s <n>] [--artifact <url>]… --dashboards <dir|file> [--acted true|false] [--registry <p>] [--deny-list <p>]",
].join("\n");

interface Flags {
  registry?: string;
  workflowsDir?: string;
  denyList?: string;
  job?: string;
  status?: string;
  outcome?: string;
  durationS?: string;
  artifacts: string[];
  dashboards?: string;
  acted: string;
}

function parseFlags(argv: string[]): { flags: Flags; error?: string } {
  const flags: Flags = { artifacts: [], acted: "true" };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (!name.startsWith("--")) return { flags, error: `unexpected argument "${name}"` };
    if (value === undefined) return { flags, error: `flag "${name}" needs a value` };
    switch (name) {
      case "--registry":
        flags.registry = value;
        break;
      case "--workflows-dir":
        flags.workflowsDir = value;
        break;
      case "--deny-list":
        flags.denyList = value;
        break;
      case "--job":
        flags.job = value;
        break;
      case "--status":
        flags.status = value;
        break;
      case "--outcome":
        flags.outcome = value;
        break;
      case "--duration-s":
        flags.durationS = value;
        break;
      case "--artifact":
        flags.artifacts.push(value);
        break;
      case "--dashboards":
        flags.dashboards = value;
        break;
      case "--acted":
        flags.acted = value;
        break;
      default:
        return { flags, error: `unknown flag "${name}"` };
    }
    i++;
  }
  return { flags };
}

function usageResult(message: string): VerbResult {
  return { json: { verb: "notturno", error: message, usage: USAGE }, code: 64 };
}

/** The deny gate: an explicit --deny-list wins, else the manifest is
 *  discovered beside the registry (and up its ancestor chain). No manifest →
 *  a public registry, pass. A manifest that fails to parse is a loud data
 *  error (2) — the gate never opens on a broken input. A matching row →
 *  64, the named reason, pointing at the private instance's runner. */
function denyGate(registry: string, denyList: string | undefined, runner: string): VerbResult | undefined {
  const manifest = denyList ?? discoverDenyList(registry);
  if (manifest === undefined) return undefined;
  const loaded = loadDenyList(manifest);
  if (!loaded.ok) return { json: { verb: "notturno", ok: false, error: loaded.error }, code: 2 };
  const row = deniedBy(registry, loaded.deny);
  if (row === undefined) return undefined;
  return {
    json: {
      verb: "notturno",
      ok: false,
      error: "registry is instance config — denied by the instance deny list",
      registry,
      deny: row,
      hint: `this registry is deny-listed instance data (${row.reason}) — run it through the private instance's runner: ${runner} in the amicissimo checkout; the public amico CLI never runs org config`,
    },
    code: 64,
  };
}

/** Resolve --registry or AMICO_NOTTURNO_REGISTRY. */
function registryPath(flags: Flags): string | undefined {
  if (flags.registry !== undefined && flags.registry !== "") return flags.registry;
  const env = process.env.AMICO_NOTTURNO_REGISTRY;
  return env && env !== "" ? env : undefined;
}

function registryCheck(argv: string[]): VerbResult {
  const { flags, error } = parseFlags(argv);
  if (error !== undefined) return usageResult(error);
  const registry = registryPath(flags);
  if (registry === undefined)
    return usageResult("no registry path — pass --registry <path> (or set AMICO_NOTTURNO_REGISTRY)");
  const denied = denyGate(registry, flags.denyList, "python -m automation.notturno.registry");
  if (denied !== undefined) return denied;
  const loaded = loadRegistry(registry);
  if (!loaded.ok)
    return { json: { verb: "notturno", subcommand: "registry-check", ok: false, error: loaded.error }, code: 2 };
  const workflowsDir = flags.workflowsDir ?? discoverWorkflowsDir(registry);
  if (workflowsDir === undefined)
    return usageResult(`no .github/workflows found above ${registry} — pass --workflows-dir <dir>`);
  const problems = coverage(loaded.registry, workflowsDir);
  const base = {
    verb: "notturno",
    subcommand: "registry-check",
    registry,
    workflows_dir: workflowsDir,
    jobs: loaded.registry.jobs.length,
    excludes: loaded.registry.excludes.length,
    problems,
  };
  if (problems.length > 0) return { json: { ...base, ok: false }, code: 1 };
  return {
    json: {
      ...base,
      ok: true,
      verdict: `coverage: total — ${loaded.registry.jobs.length} jobs, ${loaded.registry.excludes.length} excludes`,
    },
    code: 0,
  };
}

function listCommand(argv: string[]): VerbResult {
  const { flags, error } = parseFlags(argv);
  if (error !== undefined) return usageResult(error);
  const registry = registryPath(flags);
  if (registry === undefined)
    return usageResult("no registry path — pass --registry <path> (or set AMICO_NOTTURNO_REGISTRY)");
  const denied = denyGate(registry, flags.denyList, "python -m automation.notturno.registry");
  if (denied !== undefined) return denied;
  const loaded = loadRegistry(registry);
  if (!loaded.ok) return { json: { verb: "notturno", subcommand: "list", ok: false, error: loaded.error }, code: 2 };
  return {
    json: {
      verb: "notturno",
      subcommand: "list",
      ok: true,
      registry,
      jobs: [...loaded.registry.jobs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      excludes: loaded.registry.excludes,
    },
    code: 0,
  };
}

function passCommand(argv: string[]): VerbResult {
  const { flags, error } = parseFlags(argv);
  if (error !== undefined) return usageResult(error);
  if (flags.job === undefined || flags.status === undefined || flags.outcome === undefined || flags.dashboards === undefined)
    return usageResult("pass needs --job, --status, --outcome, and --dashboards");
  const registry = registryPath(flags);
  if (registry === undefined)
    return usageResult("no registry path — pass --registry <path> (or set AMICO_NOTTURNO_REGISTRY)");
  const denied = denyGate(registry, flags.denyList, "python -m automation.notturno.passes");
  if (denied !== undefined) return denied;
  const loaded = loadRegistry(registry);
  if (!loaded.ok) return { json: { verb: "notturno", subcommand: "pass", ok: false, error: loaded.error }, code: 2 };
  const job = loaded.registry.jobs.find((j) => j.id === flags.job);
  if (job === undefined)
    return {
      json: {
        verb: "notturno",
        subcommand: "pass",
        ok: false,
        error: `passes: unknown job '${flags.job}' — not in the Notturno registry`,
      },
      code: 2,
    };
  if (job.record === "acted" && flags.acted !== "true")
    return {
      json: {
        verb: "notturno",
        subcommand: "pass",
        ok: true,
        skipped: true,
        job: job.id,
        reason: `passes: ${job.id} records on action only; no action this run — skipped`,
      },
      code: 0,
    };
  if (!(PASS_STATUSES as readonly string[]).includes(flags.status))
    return {
      json: {
        verb: "notturno",
        subcommand: "pass",
        ok: false,
        error: `passes: status must be one of ('ok', 'failed'), got '${flags.status}'`,
      },
      code: 2,
    };
  const durationS = flags.durationS === undefined ? null : Number(flags.durationS);
  if (flags.durationS !== undefined && !Number.isInteger(durationS))
    return usageResult(`--duration-s must be an integer (got "${flags.durationS}")`);
  const target = appendSection(
    flags.dashboards,
    renderPass({
      job: job.id,
      status: flags.status,
      outcome: flags.outcome,
      duration_s: durationS,
      artifacts: flags.artifacts,
      when: new Date(),
    }),
  );
  return {
    json: {
      verb: "notturno",
      subcommand: "pass",
      ok: true,
      job: job.id,
      status: flags.status,
      outcome: flags.outcome,
      target,
      recorded: `passes: recorded ${job.id} (${flags.status}) in ${target}`,
    },
    code: 0,
  };
}

/** The `notturno` verb body: route on the subcommand. Backs BOTH the CLI
 *  (amico.ts — SPINE_VERBS dispatch) and the MCP facade (mcp_serve.ts — the
 *  registry auto-publishes `amico_notturno`): one impl, two transports. */
export function notturnoVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  if (sub === "registry-check") return registryCheck(argv.slice(1));
  if (sub === "list") return listCommand(argv.slice(1));
  if (sub === "pass") return passCommand(argv.slice(1));
  return {
    json: {
      verb: "notturno",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: USAGE,
    },
    code: 64,
  };
}
