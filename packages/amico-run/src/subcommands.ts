// amico-run subcommands (spec C): `resolve` (mechanical tier resolution the
// agent calls to pick a tier + source + packages) and `sandbox` (generate a
// per-problem Julia project from a package set). Both are bash-callable from
// the Amicode workflow. Dispatch only fires when argv[0] is the literal
// subcommand AND is not an existing file (a bare script named `resolve` keeps
// the launch contract).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validate } from "@amicode/schema";
import { readAuthoring } from "./authoring.js";
import { loadExemplarsIndex, loadRegistry, matchShape } from "./catalog.js";
import { estimateFromVars, extractKeyVars } from "./estimate.js";
import { JULIA_STDLIBS } from "./import_scan.js";
import { ConfigError } from "./types.js";

/** Tier-3 minimum package set — the free skeleton's `using` block AND the
 *  re-rollout harness both need these in the sandbox env, so `resolve` returns
 *  them for tier free (an empty set would generate an uninstantiable env). */
const TIER3_MIN_PACKAGES = ["Piccolo", "CairoMakie", "JLD2", "TOML", "Printf"];

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function resolveCommand(argv: string[]): number {
  const platform = flagValue(argv, "--platform");
  const kind = flagValue(argv, "--kind");
  const sizeRaw = flagValue(argv, "--size");
  if (!platform || !kind || !sizeRaw) {
    console.error("amico-run resolve: --platform, --kind, --size are all required");
    return 64;
  }
  const size = Number(sizeRaw);
  if (!Number.isFinite(size)) {
    console.error(`amico-run resolve: --size must be a number (got ${sizeRaw})`);
    return 64;
  }

  const { config } = readAuthoring();
  const registry = loadRegistry(config.registry ?? "");
  const exemplars = loadExemplarsIndex(config.exemplars ?? "");
  const match = matchShape({ platform, kind, size }, registry, exemplars, config.allowlist);

  // template/exemplar paths in the catalog are relative to their manifest file;
  // resolve to absolute so the agent can copy the script directly.
  const registryDir = config.registry ? dirname(config.registry) : process.cwd();
  const exemplarsDir = config.exemplars ? dirname(config.exemplars) : process.cwd();
  const out: Record<string, unknown> = { tier: match.tier };
  if (match.template) {
    out.source = { template_id: match.template.id };
    out.template_path = resolve(registryDir, match.template.path);
    out.packages = match.template.packages;
  } else if (match.exemplar) {
    out.source = { exemplar_id: match.exemplar.id };
    out.exemplar_path = resolve(exemplarsDir, match.exemplar.path);
    out.packages = match.exemplar.packages;
  } else {
    out.packages = TIER3_MIN_PACKAGES;
  }
  if (match.blockedHigher) out.blocked_higher = match.blockedHigher;
  console.log(JSON.stringify(out));
  return 0;
}

export function sandboxCommand(argv: string[]): number {
  const target = argv[0];
  if (!target || target.startsWith("-")) {
    console.error("amico-run sandbox: <workspace-dir> required");
    return 64;
  }
  const packagesRaw = flagValue(argv, "--packages");
  if (!packagesRaw) {
    console.error("amico-run sandbox: --packages A,B,… required");
    return 64;
  }
  const packages = packagesRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Julia stdlibs load from @stdlib in LOAD_PATH regardless of a project's
  // [deps] — they need no uuid and no [deps] entry. Filter them so the sandbox
  // is robust to ANY stdlib an authored script imports (spec-20260704-113005 §3
  // defect #2: TIER3_MIN_PACKAGES ships Printf+TOML, both stdlibs with no
  // [uuids] entry, which exit-64'd every tier-free launch at env generation).
  // Non-stdlib packages still require a uuid — the unknown-package guard holds.
  const depsNeeded = packages.filter((p) => !JULIA_STDLIBS.has(p));

  const { config } = readAuthoring();
  const registry = loadRegistry(config.registry ?? "");
  const missing = depsNeeded.filter((p) => !registry.uuids[p]);
  if (missing.length > 0) {
    console.error(`amico-run sandbox: no uuid in the registry for: ${missing.join(", ")}`);
    return 64;
  }

  const deps = depsNeeded
    .slice()
    .sort()
    .map((p) => `${p} = ${JSON.stringify(registry.uuids[p])}`)
    .join("\n");
  const envDir = join(target, "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "Project.toml"), `[deps]\n${deps}\n`);
  console.log(`amico-run: wrote ${join(envDir, "Project.toml")}`);
  console.log(`instantiate it (private git deps need CLI git):`);
  console.log(`  JULIA_PKG_USE_CLI_GIT=true julia --project=${envDir} -e 'using Pkg; Pkg.instantiate()'`);
  return 0;
}

const ESTIMATE_USAGE = "usage: amico-run estimate <script.jl> | --spec <solvespec.json>";

/** Δ10 / #34 (C1): the v0 estimator seam at SolveSpec-assembly time. Reads the
 *  solve script (directly, or via a SolveSpec's script_path), ports the aws-infra
 *  tshirt-sizing math (estimate.ts) and prints ONE JSON line:
 *    {sizeClass, score, estimatedBytes, localRamBytes, offloadSuggested, reason, inputs}
 *  The output is data for the caller (agent / #63's routing UX) — no executor is
 *  selected, no file is written, nothing auto-routes (D7 dropped the classifier). */
export function estimateCommand(argv: string[]): number {
  let scriptPath: string | undefined;
  let specPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`amico-run estimate: --spec requires a value\n${ESTIMATE_USAGE}`);
        return 64;
      }
      specPath = v;
    } else if (a.startsWith("-")) {
      console.error(`amico-run estimate: unknown flag ${a}\n${ESTIMATE_USAGE}`);
      return 64;
    } else if (scriptPath) {
      console.error(`amico-run estimate: multiple scripts given\n${ESTIMATE_USAGE}`);
      return 64;
    } else {
      scriptPath = a;
    }
  }
  if ((scriptPath && specPath) || (!scriptPath && !specPath)) {
    console.error(`amico-run estimate: give EITHER a script OR --spec, exactly one\n${ESTIMATE_USAGE}`);
    return 64;
  }

  if (specPath) {
    let specRaw: unknown;
    try {
      specRaw = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (e) {
      console.error(`amico-run estimate: cannot read --spec ${specPath}: ${(e as Error).message}`);
      return 64;
    }
    // Same step-1 validation as the launch gate (gate.ts) so #63's assembly flow
    // gets schema feedback from the SAME schema before any launch is attempted.
    const validation = validate(specRaw, "solvespec");
    if (!validation.ok) {
      console.error(`amico-run estimate: solvespec schema: ${validation.errors[0]}`);
      return 64;
    }
    const sp = (specRaw as { script_path: string }).script_path;
    // A relative script_path resolves against the spec file's directory, so a
    // spec+script pair stays relocatable. (The launch path never reads
    // script_path — the script arrives as its own argv — so no precedent binds.)
    scriptPath = isAbsolute(sp) ? sp : resolve(dirname(specPath), sp);
  }

  let content: string;
  try {
    content = readFileSync(scriptPath!, "utf8");
  } catch (e) {
    console.error(`amico-run estimate: cannot read script ${scriptPath}: ${(e as Error).message}`);
    return 64;
  }

  const vars = extractKeyVars(content);
  // Reference parity: unresolved levels contribute nothing to the score — but say so.
  if (vars.levelsUnresolved)
    console.error(`amico-run estimate: ${vars.levelsUnresolved} — levels excluded from the score (reference fallback)`);
  try {
    console.log(JSON.stringify(estimateFromVars(vars)));
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`amico-run estimate: ${e.message} (script: ${scriptPath})`);
      return 64;
    }
    throw e;
  }
}

/** Dispatch a subcommand if argv[0] names one and is not an existing file. */
export function trySubcommand(argv: string[]): number | undefined {
  const head = argv[0];
  if (head === "resolve" && !existsSync(head)) return resolveCommand(argv.slice(1));
  if (head === "sandbox" && !existsSync(head)) return sandboxCommand(argv.slice(1));
  if (head === "estimate" && !existsSync(head)) return estimateCommand(argv.slice(1));
  return undefined;
}
